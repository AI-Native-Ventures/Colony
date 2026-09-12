//! Relay-owned broker for Website Manager jobs.
//!
//! The `website_jobs` row is the authority. A client-signed action is allowed
//! to change it only after the broker has checked the actor against that row
//! and the canonical `CompanyTask`, and the row transition, the signed action,
//! the relay-signed head (kind 30203), and the relay-signed receipt (kind
//! 40028) are committed by one database transaction.
//!
//! Owner approve/request-changes decisions do not use the ordinary action
//! kind. They arrive as reserved signed Block actions (`website.approve` /
//! `website.requestChanges`) so the Blocks envelope and its idempotency
//! semantics stay the single decision path. This broker acts as a bounded
//! adapter over an already validated Block action envelope: it verifies the
//! referenced instance, the pinned processor and decision maker, the exact
//! revision/hash, and then commits the canonical state plus this broker's own
//! receipt. It never forges a kind 40011 receipt.
//!
//! Expensive public fetches happen only after a non-network preflight has
//! established that the request is authorized, current, and not an exact
//! retry; the same checks then run again under the transaction before commit.

use std::sync::Arc;

use buzz_core::kind::{
    KIND_BLOCK_ACTION, KIND_WEBSITE_ACTION, KIND_WEBSITE_HEAD, KIND_WEBSITE_RECEIPT,
};
use buzz_core::tenant::TenantContext;
use buzz_core::website::{
    is_reserved_website_action_id, parse_qa_report, parse_website_action,
    parse_website_decision_action, sha256_hex, validate_handover_assets, DecisionKind,
    DecisionOutcome, DecisionSubmission, QaEvidence, RevisionSubmission, StageEvidence,
    WebsiteAction, WebsiteActionOp, WebsiteDecisionAction, WebsiteHandover, WebsiteReview,
    WebsiteReviewInit,
};
use buzz_core::StoredEvent;
use buzz_db::website_jobs::{
    find_website_action_claim, find_website_action_claim_by_event, get_website_job,
    insert_website_action_claim_tx, insert_website_job_tx, lock_website_job_tx,
    update_website_job_cas, NewWebsiteActionClaim, NewWebsiteJob, WebsiteActionClaimRow,
    WebsiteJobRow, WebsiteJobUpdate,
};
use chrono::Utc;
use nostr::{Event, PublicKey};
use sqlx::{Postgres, Transaction};
use url::Url;
use uuid::Uuid;

use crate::blocks::ActionEnvelope;
use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;
use crate::website_authority::{
    authorize_create, authorize_update, require_actor_persona, require_decision_instance,
};
use crate::website_events::{
    build_duplicate_receipt, build_head, build_receipt, head_d_tag, insert_event_tx, next_head_at,
    replace_head_tx,
};
use crate::website_evidence::{
    load_task, require_stage_evidence, require_task_report, QaReportBinding,
};

/// Generic refusal used when a job does not exist or the actor may not see it.
pub const WEBSITE_JOB_UNAVAILABLE: &str = "website job unavailable";
/// A canonical task can own only one website job.
pub const WEBSITE_JOB_TAKEN: &str = "a website job already exists for this task";
/// The observed row generation is no longer current.
pub const WEBSITE_STALE_GENERATION: &str = "website job generation conflict";
/// A per-actor request UUID was replayed with a different payload.
pub const WEBSITE_REQUEST_REPLAY: &str = "website request replay carries a different payload";
/// An action that needs artifact bytes was submitted without them.
pub const WEBSITE_ARTIFACT_REQUIRED: &str = "website artifact bytes are required";
/// A fetched artifact did not hash to its declared digest.
pub const WEBSITE_ARTIFACT_MISMATCH: &str = "website artifact hash mismatch";
/// A website artifact could not be read under the current tenant and actor.
pub const WEBSITE_ARTIFACT_UNAVAILABLE: &str = "website artifact unavailable";

/// Resolve a canonical same-tenant Blossom path from a website artifact URL.
///
/// `Ok(None)` means the URL is an external public artifact and must continue
/// through [`crate::website_fetch`]. `Some` is returned only for the current
/// tenant's exact media origin; the caller then reads it through the tenant
/// sidecar gate rather than making an unauthenticated HTTP request. A media
/// URL on the current tenant with credentials, query, fragment, or a mismatched
/// origin is rejected instead of falling through to the public fetcher.
fn canonical_tenant_media_path(
    config_relay_url: &str,
    tenant: &TenantContext,
    raw_url: &str,
) -> Result<Option<String>, String> {
    let parsed = Url::parse(raw_url).map_err(|_| WEBSITE_ARTIFACT_UNAVAILABLE.to_owned())?;
    let Some(path) = parsed.path().strip_prefix("/media/") else {
        return Ok(None);
    };

    let authority = buzz_core::tenant::relay_url_authority(raw_url);
    if authority != tenant.host() {
        return Ok(None);
    }
    let expected_origin = Url::parse(&crate::api::media::media_base_url_for_tenant(
        config_relay_url,
        tenant.host(),
    ))
    .map_err(|_| WEBSITE_ARTIFACT_UNAVAILABLE.to_owned())?
    .origin();
    if parsed.origin() != expected_origin
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || path.is_empty()
        || path.contains('/')
    {
        return Err(WEBSITE_ARTIFACT_UNAVAILABLE.to_owned());
    }
    Ok(Some(path.to_owned()))
}

/// Fetch one website artifact, using the tenant-scoped storage path for the
/// relay's own Blossom objects and the existing pinned public fetcher for all
/// other URLs. The actor is captured explicitly so the media authorization
/// check remains tied to the signed action across every await.
async fn fetch_website_artifact(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    actor: &PublicKey,
    raw_url: &str,
) -> Result<Vec<u8>, String> {
    if let Some(path) = canonical_tenant_media_path(&state.config.relay_url, tenant, raw_url)? {
        match crate::api::relay_members::check_relay_membership(
            state,
            tenant.community(),
            actor.as_bytes(),
            None,
        )
        .await
        .map_err(|_| WEBSITE_ARTIFACT_UNAVAILABLE.to_owned())?
        {
            crate::api::relay_members::MembershipDecision::Denied => {
                return Err(WEBSITE_ARTIFACT_UNAVAILABLE.to_owned());
            }
            crate::api::relay_members::MembershipDecision::OpenRelay
            | crate::api::relay_members::MembershipDecision::Member
            | crate::api::relay_members::MembershipDecision::ViaOwner(_) => {}
        }
        return crate::api::media::read_blob_bytes_for_tenant(
            state,
            tenant,
            &path,
            buzz_core::website::MAX_MANIFEST_BYTES as u64,
        )
        .await
        .map_err(|_| WEBSITE_ARTIFACT_UNAVAILABLE.to_owned());
    }

    // A media-shaped URL for another mapped tenant must never fall through to
    // the public fetcher. Unknown public hosts remain on that fetcher's
    // existing safety path, but a server-resolved tenant mismatch is a hard
    // authorization failure (including a same-community alias, which is not
    // the canonical host bound to this action).
    if let Ok(parsed) = Url::parse(raw_url) {
        if parsed.path().strip_prefix("/media/").is_some() {
            let authority = buzz_core::tenant::relay_url_authority(raw_url);
            if !authority.is_empty()
                && crate::tenant::bind_community(&state.db, &authority)
                    .await
                    .is_ok()
            {
                return Err(WEBSITE_ARTIFACT_UNAVAILABLE.to_owned());
            }
        }
    }

    // Do not attach tenant credentials to external artifacts. The existing
    // fetcher retains its public-host DNS, redirect, and byte-budget checks.
    crate::website_fetch::fetch_bounded_bytes(raw_url).await
}

/// The durable result of one brokered website action.
#[derive(Debug)]
pub enum WebsiteBrokerOutcome {
    /// The canonical row, action, head, and receipt committed.
    Applied {
        /// The canonical row after the transition committed.
        ///
        /// Boxed so the applied variant stays close in size to `Duplicate`;
        /// the row is only read by callers after a successful transition.
        job: Box<WebsiteJobRow>,
        /// The relay-signed head that was committed, when the transition
        /// produced one. An exact-content decision retry records only a
        /// duplicate receipt against the existing head.
        head: Option<StoredEvent>,
        /// The relay-signed receipt that was committed.
        receipt: StoredEvent,
    },
    /// This request was already applied; the recorded head and receipt are
    /// returned and nothing changed.
    Duplicate {
        /// Event id of the action that won the request.
        original_action_event_id: Vec<u8>,
        /// The recorded head.
        head: StoredEvent,
        /// The recorded receipt.
        receipt: StoredEvent,
    },
}

/// Whether an event names a reserved website decision Block action.
pub fn is_reserved_website_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_BLOCK_ACTION
        && event.tags.iter().any(|tag| {
            let parts = tag.as_slice();
            parts.first().is_some_and(|part| part == "block-action")
                && parts
                    .get(2)
                    .is_some_and(|action| is_reserved_website_action_id(action))
        })
}

/// Parse, preflight, fetch referenced artifacts, and apply one signed action.
pub async fn handle_website_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
) -> Result<WebsiteBrokerOutcome, String> {
    let action =
        parse_website_action(event).map_err(|error| format!("{}: {error}", error.code()))?;
    let digest = action.payload_digest();
    if let Some(claim) = preflight_retry(
        state,
        tenant,
        &action.actor,
        action.request_id,
        event.id.as_bytes(),
        &digest,
    )
    .await?
    {
        return duplicate_outcome(state, tenant, claim).await;
    }
    preflight_action(state, tenant, &action).await?;

    // Keep the actor identity independent of any later database/storage
    // awaits. The signed action has already passed the authority preflight;
    // the same key is used for the tenant-scoped media gate below.
    let actor = action.actor;
    let manifest = match &action.op {
        WebsiteActionOp::AddRevision { manifest, .. } => {
            Some(fetch_website_artifact(state, tenant, &actor, &manifest.url).await?)
        }
        WebsiteActionOp::Handover {
            approved_revision,
            approved_manifest_sha256,
            ..
        } => Some(
            fetch_current_manifest(
                state,
                tenant,
                &action.task_id,
                &action.thread_root,
                *approved_revision,
                approved_manifest_sha256,
                &actor,
            )
            .await?,
        ),
        _ => None,
    };
    let qa_report = match &action.op {
        WebsiteActionOp::RecordQa { report, .. } => {
            Some(fetch_website_artifact(state, tenant, &actor, &report.url).await?)
        }
        _ => None,
    };
    apply_website_action(
        state,
        tenant,
        &action,
        manifest.as_deref(),
        qa_report.as_deref(),
        event,
    )
    .await
}

/// Apply a parsed website action against canonical relay state.
pub async fn apply_website_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WebsiteAction,
    manifest: Option<&[u8]>,
    qa_report: Option<&[u8]>,
    action_event: &Event,
) -> Result<WebsiteBrokerOutcome, String> {
    let community = tenant.community();
    let job_id =
        WebsiteAction::derive_job_id(*community.as_uuid(), &action.task_id, &action.thread_root);
    let digest = hex::decode(action.payload_digest())
        .map_err(|_| "website payload digest is not hexadecimal".to_owned())?;
    let actor_bytes = action.actor.to_bytes().to_vec();
    let mut tx = state
        .db
        .begin_transaction()
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?;

    if let Some(claim) = find_request_claim(
        &mut tx,
        community,
        &actor_bytes,
        action.request_id,
        action_event.id.as_bytes(),
        &digest,
    )
    .await?
    {
        tx.rollback()
            .await
            .map_err(|error| format!("website transaction failed: {error}"))?;
        return duplicate_outcome(state, tenant, claim).await;
    }

    let outcome = match &action.op {
        WebsiteActionOp::Create { .. } => {
            apply_create(
                state,
                tenant,
                &mut tx,
                action,
                action_event,
                job_id,
                &digest,
                &actor_bytes,
            )
            .await
        }
        _ => {
            apply_update(
                state,
                tenant,
                &mut tx,
                action,
                action_event,
                manifest,
                qa_report,
                job_id,
                &digest,
                &actor_bytes,
            )
            .await
        }
    };

    match outcome {
        Ok(ApplyResult::Committed(committed)) => {
            tx.commit()
                .await
                .map_err(|error| format!("website transaction failed: {error}"))?;
            dispatch_committed(tenant, state, &committed, KIND_WEBSITE_ACTION).await;
            Ok(WebsiteBrokerOutcome::Applied {
                job: Box::new(committed.job),
                head: committed.head,
                receipt: committed.receipt,
            })
        }
        Ok(ApplyResult::Duplicate(claim)) => {
            tx.rollback()
                .await
                .map_err(|error| format!("website transaction failed: {error}"))?;
            duplicate_outcome(state, tenant, claim).await
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

/// Apply one reserved website decision Block action that already passed
/// generic Block validation.
///
/// Ingest calls this only after `blocks::validate_public_envelope` accepted
/// the event, so manifest declaration, trusted-active manifest, processor pin,
/// and the attention decision-maker signature have all been enforced by the
/// generic pipeline. This adapter adds the canonical job binding (instance
/// identity, task/thread data, generation CAS) and persists the transition
/// under the website claim boundary.
pub(crate) async fn handle_validated_website_block_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    event: &Event,
    action: &ActionEnvelope,
) -> Result<WebsiteBrokerOutcome, String> {
    if !is_reserved_website_action_id(&action.action_id) {
        return Err("event does not name a reserved website decision".to_owned());
    }
    let decision = parse_website_decision_action(&action.action_id, &action.content)
        .map_err(|error| format!("{}: {error}", error.code()))?;
    let digest = decision.payload_digest();
    if let Some(claim) = preflight_retry(
        state,
        tenant,
        &event.pubkey,
        action.idempotency_key,
        event.id.as_bytes(),
        &digest,
    )
    .await?
    {
        return duplicate_outcome(state, tenant, claim).await;
    }
    preflight_decision(state, tenant, event, action, &decision).await?;
    apply_website_decision(state, tenant, event, action, &decision).await
}

/// Apply a parsed owner decision carried by a validated Block action.
pub(crate) async fn apply_website_decision(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    block_action: &ActionEnvelope,
    decision: &WebsiteDecisionAction,
) -> Result<WebsiteBrokerOutcome, String> {
    let community = tenant.community();
    let actor_bytes = action_event.pubkey.to_bytes().to_vec();
    let digest = hex::decode(decision.payload_digest())
        .map_err(|_| "website payload digest is not hexadecimal".to_owned())?;
    let mut tx = state
        .db
        .begin_transaction()
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?;

    if let Some(claim) = find_request_claim(
        &mut tx,
        community,
        &actor_bytes,
        block_action.idempotency_key,
        action_event.id.as_bytes(),
        &digest,
    )
    .await?
    {
        tx.rollback()
            .await
            .map_err(|error| format!("website transaction failed: {error}"))?;
        return duplicate_outcome(state, tenant, claim).await;
    }

    let result = apply_decision_inner(
        state,
        tenant,
        &mut tx,
        action_event,
        block_action,
        decision,
        &digest,
        &actor_bytes,
    )
    .await;

    match result {
        Ok(ApplyResult::Committed(committed)) => {
            tx.commit()
                .await
                .map_err(|error| format!("website transaction failed: {error}"))?;
            dispatch_committed(tenant, state, &committed, KIND_BLOCK_ACTION).await;
            Ok(WebsiteBrokerOutcome::Applied {
                job: Box::new(committed.job),
                head: committed.head,
                receipt: committed.receipt,
            })
        }
        Ok(ApplyResult::Duplicate(claim)) => {
            tx.rollback()
                .await
                .map_err(|error| format!("website transaction failed: {error}"))?;
            duplicate_outcome(state, tenant, claim).await
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

/// What one committed transaction produced.
struct Committed {
    job: WebsiteJobRow,
    head: Option<StoredEvent>,
    receipt: StoredEvent,
    action: Option<StoredEvent>,
}

/// Either a commit to dispatch or a request already claimed by another event.
enum ApplyResult {
    /// Boxed because a `Committed` carries two stored events plus a row, while
    /// the duplicate arm is only a few event ids.
    Committed(Box<Committed>),
    Duplicate(DuplicateClaim),
}

/// The recorded coordinates of an already-applied request.
struct DuplicateClaim {
    original_action_event_id: Vec<u8>,
    head_event_id: Vec<u8>,
    receipt_event_id: Vec<u8>,
}

/// Coordinates common to every committed update.
struct UpdateContext<'a> {
    channel_id: Uuid,
    task_id: &'a str,
    thread_root: &'a str,
    request_id: Uuid,
    actor_hex: String,
    op_name: &'a str,
}

/// Return a recorded result for an exact retry before any fetch or write.
async fn preflight_retry(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    actor: &PublicKey,
    request_id: Uuid,
    action_event_id: &[u8],
    digest_hex: &str,
) -> Result<Option<DuplicateClaim>, String> {
    let digest = hex::decode(digest_hex)
        .map_err(|_| "website payload digest is not hexadecimal".to_owned())?;
    let community = tenant.community();
    if let Some(row) =
        find_website_action_claim(state.db.pool(), community, actor.as_bytes(), request_id)
            .await
            .map_err(|error| format!("website transaction failed: {error}"))?
    {
        if row.payload_digest.as_slice() != digest {
            return Err(WEBSITE_REQUEST_REPLAY.to_owned());
        }
        return Ok(Some(claim_of(row)));
    }
    if let Some(row) =
        find_website_action_claim_by_event(state.db.pool(), community, action_event_id)
            .await
            .map_err(|error| format!("website transaction failed: {error}"))?
    {
        if row.payload_digest.as_slice() != digest {
            return Err(WEBSITE_REQUEST_REPLAY.to_owned());
        }
        return Ok(Some(claim_of(row)));
    }
    Ok(None)
}

/// Authorize and check currency without any network access.
async fn preflight_action(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action: &WebsiteAction,
) -> Result<(), String> {
    match &action.op {
        WebsiteActionOp::Create { .. } => {
            authorize_create(state, tenant, action, &action.actor.to_bytes())
                .await
                .map(|_| ())
        }
        _ => {
            let job_id = WebsiteAction::derive_job_id(
                *tenant.community().as_uuid(),
                &action.task_id,
                &action.thread_root,
            );
            let job = get_website_job(state.db.pool(), tenant.community(), job_id)
                .await
                .map_err(|error| format!("database error loading the website job: {error}"))?
                .ok_or_else(|| WEBSITE_JOB_UNAVAILABLE.to_owned())?;
            if job.channel_id != action.channel_id || job.task_id != action.task_id {
                return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
            }
            let task = load_task(tenant, state, &action.task_id).await?;
            if authorize_update(state, tenant, action, &job, &task, &action.actor.to_bytes())
                .await
                .is_err()
            {
                return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
            }
            let observed = action
                .generation
                .ok_or_else(|| WEBSITE_STALE_GENERATION.to_owned())?;
            if observed != u64::try_from(job.generation).unwrap_or(u64::MAX) {
                return Err(WEBSITE_STALE_GENERATION.to_owned());
            }
            Ok(())
        }
    }
}

/// Authorize and check a decision without any network access.
async fn preflight_decision(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    block_action: &ActionEnvelope,
    decision: &WebsiteDecisionAction,
) -> Result<(), String> {
    let job = get_website_job(state.db.pool(), tenant.community(), decision.job_id)
        .await
        .map_err(|error| format!("database error loading the website job: {error}"))?
        .ok_or_else(|| WEBSITE_JOB_UNAVAILABLE.to_owned())?;
    if job.task_id != decision.task_id {
        return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    if require_decision_instance(state, tenant, &job, block_action)
        .await
        .is_err()
    {
        return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    let actor = action_event.pubkey.to_bytes();
    // The review card pins attention to the owner, so every Block decision
    // (approve or request-changes) is owner-signed. The coordinator's
    // request-changes is the ordinary `requestChanges` website action.
    if actor.as_slice() != job.owner.as_slice() {
        return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    if decision.generation != u64::try_from(job.generation).unwrap_or(u64::MAX) {
        return Err(WEBSITE_STALE_GENERATION.to_owned());
    }
    Ok(())
}

/// All assigned personas of a job, in role order.
fn job_participants(job: &WebsiteJobRow) -> Vec<String> {
    let mut participants = job.research_personas.clone();
    participants.extend(job.build_personas.iter().cloned());
    participants.extend(job.review_personas.iter().cloned());
    participants
}

/// The QA persona is the first assigned review persona.
fn job_qa_persona(job: &WebsiteJobRow) -> Result<String, String> {
    job.review_personas
        .first()
        .cloned()
        .ok_or_else(|| "reviewPersonas must name a QA persona".to_owned())
}

/// Reopen or widen the canonical task when a revision is requested.
async fn reopen_task_for_revision(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    job: &WebsiteJobRow,
) -> Result<(), String> {
    crate::thread_task_broker::reconcile_website_task(
        tenant,
        state,
        &job.owner,
        &job.task_id,
        job.channel_id,
        &job.thread_root,
        &job_participants(job),
        &job_qa_persona(job)?,
        true,
    )
    .await
    .map(|_| ())
}

/// Commit a duplicate receipt for an exact-content retry of a transition.
#[allow(clippy::too_many_arguments)]
async fn commit_duplicate_receipt(
    tenant: &TenantContext,
    tx: &mut Transaction<'static, Postgres>,
    action_event: &Event,
    job: &WebsiteJobRow,
    actor_bytes: &[u8],
    request_id: Uuid,
    op: &str,
    digest: &[u8],
    receipt: &Event,
) -> Result<ApplyResult, String> {
    if !claim_action(
        &mut *tx,
        tenant.community(),
        actor_bytes,
        request_id,
        job.job_id,
        action_event,
        op,
        digest,
        &job.head_event_id,
        receipt.id.as_bytes(),
        job.generation,
    )
    .await?
    {
        let claim = winner_claim(
            &mut *tx,
            tenant.community(),
            actor_bytes,
            request_id,
            action_event.id.as_bytes(),
            digest,
        )
        .await?;
        return Ok(ApplyResult::Duplicate(claim));
    }
    let stored_action = insert_event_tx(
        &mut *tx,
        tenant.community(),
        action_event,
        Some(job.channel_id),
    )
    .await?;
    let stored_receipt =
        insert_event_tx(&mut *tx, tenant.community(), receipt, Some(job.channel_id)).await?;
    Ok(ApplyResult::Committed(Box::new(Committed {
        job: job.clone(),
        head: None,
        receipt: stored_receipt,
        action: Some(stored_action),
    })))
}

#[allow(clippy::too_many_arguments)]
async fn apply_create(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tx: &mut Transaction<'static, Postgres>,
    action: &WebsiteAction,
    action_event: &Event,
    job_id: Uuid,
    digest: &[u8],
    actor_bytes: &[u8],
) -> Result<ApplyResult, String> {
    let authority = authorize_create(state, tenant, action, actor_bytes).await?;
    if lock_website_job_tx(&mut *tx, tenant.community(), job_id)
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?
        .is_some()
    {
        return Err(WEBSITE_JOB_TAKEN.to_owned());
    }

    // Widen the canonical task assignment from the owner's installed teams so
    // each participant is really dispatched and the reviewer's report cannot
    // close the task early. The same authority checks already passed above.
    let qa_persona = authority
        .review_personas
        .first()
        .cloned()
        .ok_or_else(|| "reviewPersonas must name a QA persona".to_owned())?;
    let mut participants = authority.research_personas.clone();
    participants.extend(authority.build_personas.iter().cloned());
    participants.extend(authority.review_personas.iter().cloned());
    participants.push(authority.coordinator_persona.clone());
    crate::thread_task_broker::reconcile_website_task(
        tenant,
        state,
        &authority.owner,
        &action.task_id,
        action.channel_id,
        &action.thread_root,
        &participants,
        &qa_persona,
        false,
    )
    .await?;

    let init = WebsiteReviewInit {
        job_id,
        task_id: action.task_id.clone(),
        channel: action.channel_id.to_string(),
        thread_root: action.thread_root.clone(),
        owner: hex::encode(&authority.owner),
        coordinator: Some(hex::encode(&authority.coordinator)),
        source_url: authority.source_url.clone(),
    };
    let review = WebsiteReview::new(init).map_err(map_website_error)?;
    let review_bytes = serde_json::to_vec(&review)
        .map_err(|error| format!("failed to serialize the website review: {error}"))?;

    let now = Utc::now().timestamp();
    // A brand-new job has no predecessor head, so its first head keeps `now`.
    let head_at = next_head_at(now, None);
    let generation = 1_u64;
    let head = build_head(
        &state.relay_keypair,
        job_id,
        action.channel_id,
        &action.task_id,
        &action.thread_root,
        &authority.instance_event_id,
        &authority.manifest_event_id,
        &authority.owner,
        &authority.coordinator,
        generation,
        &review_bytes,
        head_at,
    )?;
    let receipt = build_receipt(
        &state.relay_keypair,
        job_id,
        action.channel_id,
        &action.task_id,
        &action.thread_root,
        &action.actor.to_hex(),
        action.op_name(),
        generation,
        review.current_revision,
        &hex::encode(head.id.as_bytes()),
        None,
        action_event,
    )?;

    // The job row must exist before its action claim: `website_actions` has a
    // composite foreign key onto `website_jobs (community_id, job_id)`, so a
    // claim for a brand-new job is rejected by Postgres unless the row is
    // inserted first. Both statements share this transaction, so if the claim
    // then loses (duplicate request id) the whole transaction rolls back and
    // no job row survives. Do not reorder these back.
    let job = insert_website_job_tx(
        &mut *tx,
        tenant.community(),
        NewWebsiteJob {
            job_id,
            task_id: &action.task_id,
            channel_id: action.channel_id,
            thread_root: &action.thread_root,
            instance_event_id: &authority.instance_event_id,
            manifest_event_id: &authority.manifest_event_id,
            owner: &authority.owner,
            coordinator: &authority.coordinator,
            source_url: &authority.source_url,
            review: &review_bytes,
            research_personas: &authority.research_personas,
            build_personas: &authority.build_personas,
            review_personas: &authority.review_personas,
            head_event_id: head.id.as_bytes(),
            head_at,
            now,
        },
    )
    .await
    .map_err(|error| format!("website transaction failed: {error}"))?
    .ok_or_else(|| WEBSITE_JOB_TAKEN.to_owned())?;

    if !claim_action(
        &mut *tx,
        tenant.community(),
        actor_bytes,
        action.request_id,
        job_id,
        action_event,
        action.op_name(),
        digest,
        head.id.as_bytes(),
        receipt.id.as_bytes(),
        1,
    )
    .await?
    {
        let claim = winner_claim(
            &mut *tx,
            tenant.community(),
            actor_bytes,
            action.request_id,
            action_event.id.as_bytes(),
            digest,
        )
        .await?;
        return Ok(ApplyResult::Duplicate(claim));
    }

    let stored_action = insert_event_tx(
        &mut *tx,
        tenant.community(),
        action_event,
        Some(action.channel_id),
    )
    .await?;
    let stored_head = replace_head_tx(
        &mut *tx,
        tenant.community(),
        &head,
        &head_d_tag(job_id),
        action.channel_id,
    )
    .await?;
    let stored_receipt = insert_event_tx(
        &mut *tx,
        tenant.community(),
        &receipt,
        Some(action.channel_id),
    )
    .await?;

    Ok(ApplyResult::Committed(Box::new(Committed {
        job,
        head: Some(stored_head),
        receipt: stored_receipt,
        action: Some(stored_action),
    })))
}

#[allow(clippy::too_many_arguments)]
async fn apply_update(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tx: &mut Transaction<'static, Postgres>,
    action: &WebsiteAction,
    action_event: &Event,
    manifest: Option<&[u8]>,
    qa_report: Option<&[u8]>,
    job_id: Uuid,
    digest: &[u8],
    actor_bytes: &[u8],
) -> Result<ApplyResult, String> {
    let job = lock_website_job_tx(&mut *tx, tenant.community(), job_id)
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?
        .ok_or_else(|| WEBSITE_JOB_UNAVAILABLE.to_owned())?;
    if job.channel_id != action.channel_id || job.task_id != action.task_id {
        return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    let observed = action
        .generation
        .ok_or_else(|| WEBSITE_STALE_GENERATION.to_owned())?;
    if observed != u64::try_from(job.generation).unwrap_or(u64::MAX) {
        return Err(WEBSITE_STALE_GENERATION.to_owned());
    }
    let task = load_task(tenant, state, &action.task_id).await?;
    authorize_update(state, tenant, action, &job, &task, actor_bytes).await?;

    let mut review = WebsiteReview::parse(&job.review).map_err(map_website_error)?;
    match &action.op {
        WebsiteActionOp::Create { .. } => return Err("website job already exists".to_owned()),
        WebsiteActionOp::BeginWork => {
            review.begin_work().map_err(map_website_error)?;
        }
        WebsiteActionOp::AddRevision {
            revision,
            manifest: preview,
            source_url,
            archive,
            captures,
        } => {
            let bytes = manifest.ok_or_else(|| WEBSITE_ARTIFACT_REQUIRED.to_owned())?;
            if sha256_hex(bytes) != preview.sha256 {
                return Err(WEBSITE_ARTIFACT_MISMATCH.to_owned());
            }
            let manifest_text = String::from_utf8(bytes.to_vec())
                .map_err(|_| "the preview manifest is not UTF-8".to_owned())?;
            review
                .record_revision(RevisionSubmission {
                    revision: *revision,
                    manifest: manifest_text,
                    preview: preview.clone(),
                    source_url: source_url.clone(),
                    archive: archive.clone(),
                    captures: captures.clone(),
                    built_by: action.actor.to_hex(),
                })
                .map_err(map_website_error)?;
        }
        WebsiteActionOp::RecordQa {
            revision,
            passed,
            report_event_id,
            report,
        } => {
            let manifest_sha256 = review
                .revisions
                .iter()
                .find(|candidate| candidate.revision == *revision)
                .map(|candidate| candidate.preview.sha256.clone())
                .ok_or_else(|| format!("unknown revision {revision}"))?;
            require_task_report(
                tenant,
                state,
                report_event_id,
                &action.actor,
                &job.task_id,
                action.channel_id,
                &QaReportBinding {
                    revision: *revision,
                    manifest_sha256: &manifest_sha256,
                    report_url: &report.url,
                    report_sha256: &report.sha256,
                },
            )
            .await?;
            let bytes = qa_report.ok_or_else(|| "QA report bytes are required".to_owned())?;
            if sha256_hex(bytes) != report.sha256 {
                return Err(WEBSITE_ARTIFACT_MISMATCH.to_owned());
            }
            let parsed = parse_qa_report(bytes).map_err(map_website_error)?;
            if parsed.reviewer != action.actor.to_hex() {
                return Err("QA report reviewer does not match the acting agent".to_owned());
            }
            if parsed.revision != *revision {
                return Err("QA report reviews a different revision".to_owned());
            }
            if parsed.manifest_sha256 != manifest_sha256 {
                return Err("QA report reviews a different manifest".to_owned());
            }
            parsed.agrees_with(*passed).map_err(map_website_error)?;
            review
                .record_qa(
                    *revision,
                    QaEvidence {
                        reviewer: action.actor.to_hex(),
                        revision: *revision,
                        manifest_sha256,
                        passed: *passed,
                        report_event_id: report_event_id.clone(),
                        report: report.clone(),
                    },
                )
                .map_err(map_website_error)?;
        }
        WebsiteActionOp::StageEvidence {
            stage,
            revision,
            kind,
            event_id,
        } => {
            let revision_manifest = revision.and_then(|revision| {
                review
                    .revisions
                    .iter()
                    .find(|candidate| candidate.revision == revision)
                    .map(|candidate| candidate.preview.sha256.clone())
            });
            require_stage_evidence(
                tenant,
                state,
                event_id,
                &action.actor,
                &job,
                *kind,
                revision_manifest.as_deref(),
            )
            .await?;
            review
                .attach_evidence(StageEvidence {
                    stage: *stage,
                    revision: *revision,
                    kind: *kind,
                    event_id: event_id.clone(),
                })
                .map_err(map_website_error)?;
        }
        WebsiteActionOp::Ready => {
            review.mark_ready_for_review().map_err(map_website_error)?;
        }
        WebsiteActionOp::RequestChanges {
            revision,
            manifest_sha256,
            note,
        } => {
            reopen_task_for_revision(tenant, state, &job).await?;
            let submission = DecisionSubmission {
                job_id,
                task_id: action.task_id.clone(),
                channel: action.channel_id.to_string(),
                kind: DecisionKind::RequestChanges,
                revision: *revision,
                manifest_sha256: manifest_sha256.clone(),
                actor: action.actor.to_hex(),
                note: Some(note.clone()),
            };
            let decision_id = submission.derive_id();
            match review
                .apply_decision(submission)
                .map_err(map_website_error)?
            {
                DecisionOutcome::Applied(_) => {
                    let new_revision = i32::try_from(review.current_revision)
                        .map_err(|_| "website revision out of range".to_owned())?;
                    let context = UpdateContext {
                        channel_id: action.channel_id,
                        task_id: &action.task_id,
                        thread_root: &action.thread_root,
                        request_id: action.request_id,
                        actor_hex: action.actor.to_hex(),
                        op_name: "requestChanges",
                    };
                    return commit_update(
                        state,
                        tenant,
                        &mut *tx,
                        &context,
                        action_event,
                        &job,
                        &review,
                        new_revision,
                        digest,
                        actor_bytes,
                        Some(decision_id.to_string()),
                    )
                    .await;
                }
                DecisionOutcome::Duplicate(_) => {
                    let receipt = build_duplicate_receipt(
                        &state.relay_keypair,
                        action_event,
                        job.job_id,
                        job.channel_id,
                        &job.task_id,
                        &job.thread_root,
                        "requestChanges",
                        "website-action",
                        job.generation,
                        review.current_revision,
                        &hex::encode(&job.head_event_id),
                        Some(decision_id.to_string()),
                    )?;
                    return commit_duplicate_receipt(
                        tenant,
                        &mut *tx,
                        action_event,
                        &job,
                        actor_bytes,
                        action.request_id,
                        "requestChanges",
                        digest,
                        &receipt,
                    )
                    .await;
                }
            }
        }
        WebsiteActionOp::Handover {
            approved_revision,
            approved_manifest_sha256,
            source_url,
            source_archive,
            assets,
            access_request,
        } => {
            let bytes = manifest.ok_or_else(|| WEBSITE_ARTIFACT_REQUIRED.to_owned())?;
            if sha256_hex(bytes) != *approved_manifest_sha256 {
                return Err(WEBSITE_ARTIFACT_MISMATCH.to_owned());
            }
            if let Some(access) = access_request {
                let author = PublicKey::parse(&access.authored_by)
                    .map_err(|_| "the access request author is not a valid pubkey".to_owned())?;
                require_actor_persona(
                    tenant,
                    state,
                    &job,
                    &task,
                    &author,
                    &job.build_personas,
                    "accessRequest",
                )
                .await?;
            }
            let handover = WebsiteHandover {
                job_id,
                task_id: action.task_id.clone(),
                approved_revision: *approved_revision,
                approved_manifest_sha256: approved_manifest_sha256.clone(),
                source_url: source_url.clone(),
                source_archive: source_archive.clone(),
                assets: assets.clone(),
                access_request: access_request.clone(),
                accepted_by: action.actor.to_hex(),
            };
            validate_handover_assets(&handover, bytes).map_err(map_website_error)?;
            review
                .record_handover(handover)
                .map_err(map_website_error)?;
        }
    }

    let new_revision = i32::try_from(review.current_revision)
        .map_err(|_| "website revision out of range".to_owned())?;
    let context = UpdateContext {
        channel_id: action.channel_id,
        task_id: &action.task_id,
        thread_root: &action.thread_root,
        request_id: action.request_id,
        actor_hex: action.actor.to_hex(),
        op_name: action.op_name(),
    };
    commit_update(
        state,
        tenant,
        &mut *tx,
        &context,
        action_event,
        &job,
        &review,
        new_revision,
        digest,
        actor_bytes,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn apply_decision_inner(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tx: &mut Transaction<'static, Postgres>,
    action_event: &Event,
    block_action: &ActionEnvelope,
    decision: &WebsiteDecisionAction,
    digest: &[u8],
    actor_bytes: &[u8],
) -> Result<ApplyResult, String> {
    let job = lock_website_job_tx(&mut *tx, tenant.community(), decision.job_id)
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?
        .ok_or_else(|| WEBSITE_JOB_UNAVAILABLE.to_owned())?;
    if job.task_id != decision.task_id {
        return Err(WEBSITE_JOB_UNAVAILABLE.to_owned());
    }
    require_decision_instance(state, tenant, &job, block_action).await?;
    if decision.generation != u64::try_from(job.generation).unwrap_or(u64::MAX) {
        return Err(WEBSITE_STALE_GENERATION.to_owned());
    }
    let actor = action_event.pubkey.to_bytes();
    // The review card pins attention to the owner. A Block action against an
    // attention Block must be signed by that decision maker, so both an
    // approval and a Block change request are owner-signed. A coordinator
    // requests changes through the ordinary `requestChanges` channel action,
    // which this broker authorizes separately.
    if actor.as_slice() != job.owner.as_slice() {
        return Err("the website decision actor is not authorized for this revision".to_owned());
    }

    let mut review = WebsiteReview::parse(&job.review).map_err(map_website_error)?;
    let submission = DecisionSubmission {
        job_id: decision.job_id,
        task_id: decision.task_id.clone(),
        channel: job.channel_id.to_string(),
        kind: decision.kind,
        revision: decision.revision,
        manifest_sha256: decision.manifest_sha256.clone(),
        actor: action_event.pubkey.to_hex(),
        note: decision.note.clone(),
    };
    let decision_id = submission.derive_id();
    let applied = review
        .apply_decision(submission)
        .map_err(map_website_error)?;

    match applied {
        DecisionOutcome::Applied(_) => {
            if decision.kind == DecisionKind::RequestChanges {
                reopen_task_for_revision(tenant, state, &job).await?;
            }
            let new_revision = i32::try_from(review.current_revision)
                .map_err(|_| "website revision out of range".to_owned())?;
            let context = UpdateContext {
                channel_id: job.channel_id,
                task_id: &decision.task_id,
                thread_root: &job.thread_root,
                request_id: block_action.idempotency_key,
                actor_hex: action_event.pubkey.to_hex(),
                op_name: decision.op_name(),
            };
            commit_update(
                state,
                tenant,
                &mut *tx,
                &context,
                action_event,
                &job,
                &review,
                new_revision,
                digest,
                actor_bytes,
                Some(decision_id.to_string()),
            )
            .await
        }
        DecisionOutcome::Duplicate(_) => {
            let receipt = build_duplicate_receipt(
                &state.relay_keypair,
                action_event,
                job.job_id,
                job.channel_id,
                &job.task_id,
                &job.thread_root,
                decision.op_name(),
                "block-action",
                job.generation,
                review.current_revision,
                &hex::encode(&job.head_event_id),
                Some(decision_id.to_string()),
            )?;
            commit_duplicate_receipt(
                tenant,
                &mut *tx,
                action_event,
                &job,
                actor_bytes,
                block_action.idempotency_key,
                decision.op_name(),
                digest,
                &receipt,
            )
            .await
        }
    }
}

/// Build the canonical head, claim the request, CAS the row, and persist.
#[allow(clippy::too_many_arguments)]
async fn commit_update(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    tx: &mut Transaction<'static, Postgres>,
    context: &UpdateContext<'_>,
    action_event: &Event,
    job: &WebsiteJobRow,
    review: &WebsiteReview,
    new_revision: i32,
    digest: &[u8],
    actor_bytes: &[u8],
    decision_id: Option<String>,
) -> Result<ApplyResult, String> {
    let review_bytes = serde_json::to_vec(review)
        .map_err(|error| format!("failed to serialize the website review: {error}"))?;
    let now = Utc::now().timestamp();
    // The row is already locked, so `head_at` is this job's previous head
    // stamp. A replacement must order strictly after it even when both
    // transitions land in the same second, or the NIP-33 tie-break refuses the
    // second head and an ordinary rapid transition is lost.
    let head_at = next_head_at(now, Some(job.head_at));
    let generation = u64::try_from(job.generation)
        .ok()
        .and_then(|generation| generation.checked_add(1))
        .ok_or_else(|| "website generation overflow".to_owned())?;
    let head = build_head(
        &state.relay_keypair,
        job.job_id,
        context.channel_id,
        context.task_id,
        context.thread_root,
        &job.instance_event_id,
        &job.manifest_event_id,
        &job.owner,
        &job.coordinator,
        generation,
        &review_bytes,
        head_at,
    )?;
    let receipt = build_receipt(
        &state.relay_keypair,
        job.job_id,
        context.channel_id,
        context.task_id,
        context.thread_root,
        &context.actor_hex,
        context.op_name,
        generation,
        review.current_revision,
        &hex::encode(head.id.as_bytes()),
        decision_id,
        action_event,
    )?;

    if !claim_action(
        &mut *tx,
        tenant.community(),
        actor_bytes,
        context.request_id,
        job.job_id,
        action_event,
        context.op_name,
        digest,
        head.id.as_bytes(),
        receipt.id.as_bytes(),
        i64::try_from(generation).unwrap_or(i64::MAX),
    )
    .await?
    {
        let claim = winner_claim(
            &mut *tx,
            tenant.community(),
            actor_bytes,
            context.request_id,
            action_event.id.as_bytes(),
            digest,
        )
        .await?;
        return Ok(ApplyResult::Duplicate(claim));
    }

    let updated = update_website_job_cas(
        &mut *tx,
        tenant.community(),
        job.job_id,
        job.generation,
        WebsiteJobUpdate {
            status: review.status.as_str(),
            current_revision: new_revision,
            review: &review_bytes,
            head_event_id: head.id.as_bytes(),
            head_at,
            now,
        },
    )
    .await
    .map_err(|error| format!("website transaction failed: {error}"))?
    .ok_or_else(|| WEBSITE_STALE_GENERATION.to_owned())?;

    let stored_action = insert_event_tx(
        &mut *tx,
        tenant.community(),
        action_event,
        Some(context.channel_id),
    )
    .await?;
    let stored_head = replace_head_tx(
        &mut *tx,
        tenant.community(),
        &head,
        &head_d_tag(job.job_id),
        context.channel_id,
    )
    .await?;
    let stored_receipt = insert_event_tx(
        &mut *tx,
        tenant.community(),
        &receipt,
        Some(context.channel_id),
    )
    .await?;

    Ok(ApplyResult::Committed(Box::new(Committed {
        job: updated,
        head: Some(stored_head),
        receipt: stored_receipt,
        action: Some(stored_action),
    })))
}

/// Look up an already-applied request by request UUID or exact event id.
async fn find_request_claim(
    tx: &mut Transaction<'static, Postgres>,
    community: buzz_core::CommunityId,
    actor: &[u8],
    request_id: Uuid,
    action_event_id: &[u8],
    digest: &[u8],
) -> Result<Option<DuplicateClaim>, String> {
    if let Some(row) = find_website_action_claim(&mut **tx, community, actor, request_id)
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?
    {
        if row.payload_digest.as_slice() != digest {
            return Err(WEBSITE_REQUEST_REPLAY.to_owned());
        }
        return Ok(Some(claim_of(row)));
    }
    if let Some(row) = find_website_action_claim_by_event(&mut **tx, community, action_event_id)
        .await
        .map_err(|error| format!("website transaction failed: {error}"))?
    {
        if row.payload_digest.as_slice() != digest {
            return Err(WEBSITE_REQUEST_REPLAY.to_owned());
        }
        return Ok(Some(claim_of(row)));
    }
    Ok(None)
}

async fn winner_claim(
    tx: &mut Transaction<'static, Postgres>,
    community: buzz_core::CommunityId,
    actor: &[u8],
    request_id: Uuid,
    action_event_id: &[u8],
    digest: &[u8],
) -> Result<DuplicateClaim, String> {
    find_request_claim(tx, community, actor, request_id, action_event_id, digest)
        .await?
        .ok_or_else(|| "website action claim conflict had no durable winning row".to_owned())
}

fn claim_of(row: WebsiteActionClaimRow) -> DuplicateClaim {
    DuplicateClaim {
        original_action_event_id: row.action_event_id,
        head_event_id: row.head_event_id,
        receipt_event_id: row.receipt_event_id,
    }
}

async fn duplicate_outcome(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    claim: DuplicateClaim,
) -> Result<WebsiteBrokerOutcome, String> {
    // The claim row is the authorization for this read: these exact event ids
    // were recorded as this request's committed result. The including-deleted
    // read is required because a later transition soft-deletes the previous
    // head, and an exact retry after that must still return the recorded
    // result rather than "head not found".
    let head = state
        .db
        .get_event_by_id_including_deleted(tenant.community(), &claim.head_event_id)
        .await
        .map_err(|error| format!("database error loading the recorded head: {error}"))?
        .ok_or_else(|| "the recorded website head was not found".to_owned())?;
    let receipt = state
        .db
        .get_event_by_id_including_deleted(tenant.community(), &claim.receipt_event_id)
        .await
        .map_err(|error| format!("database error loading the recorded receipt: {error}"))?
        .ok_or_else(|| "the recorded website receipt was not found".to_owned())?;
    Ok(WebsiteBrokerOutcome::Duplicate {
        original_action_event_id: claim.original_action_event_id,
        head,
        receipt,
    })
}

#[allow(clippy::too_many_arguments)]
async fn claim_action(
    tx: &mut Transaction<'static, Postgres>,
    community: buzz_core::CommunityId,
    actor: &[u8],
    request_id: Uuid,
    job_id: Uuid,
    action_event: &Event,
    op: &str,
    digest: &[u8],
    head_event_id: &[u8],
    receipt_event_id: &[u8],
    generation: i64,
) -> Result<bool, String> {
    insert_website_action_claim_tx(
        &mut *tx,
        community,
        NewWebsiteActionClaim {
            actor,
            request_id,
            job_id,
            action_event_id: action_event.id.as_bytes(),
            op,
            payload_digest: digest,
            head_event_id,
            receipt_event_id,
            generation,
        },
    )
    .await
    .map_err(|error| format!("website transaction failed: {error}"))
}

/// Fetch the current revision's manifest bytes for a handover.
async fn fetch_current_manifest(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    task_id: &str,
    thread_root: &str,
    approved_revision: u32,
    approved_manifest_sha256: &str,
    actor: &PublicKey,
) -> Result<Vec<u8>, String> {
    let job_id = WebsiteAction::derive_job_id(*tenant.community().as_uuid(), task_id, thread_root);
    let job = get_website_job(state.db.pool(), tenant.community(), job_id)
        .await
        .map_err(|error| format!("database error loading the website job: {error}"))?
        .ok_or_else(|| WEBSITE_JOB_UNAVAILABLE.to_owned())?;
    let review = WebsiteReview::parse(&job.review).map_err(map_website_error)?;
    let revision = review
        .revisions
        .iter()
        .find(|candidate| candidate.revision == approved_revision)
        .ok_or_else(|| "the approved revision does not exist".to_owned())?;
    if revision.preview.sha256 != approved_manifest_sha256 {
        return Err(WEBSITE_ARTIFACT_MISMATCH.to_owned());
    }
    fetch_website_artifact(state, tenant, actor, &revision.preview.url).await
}

fn map_website_error(error: buzz_core::website::WebsiteError) -> String {
    format!("{}: {error}", error.code())
}

async fn dispatch_committed(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    committed: &Committed,
    action_kind: u32,
) {
    let relay_pubkey = state.relay_keypair.public_key().to_hex();
    if let Some(action) = &committed.action {
        dispatch_persistent_event(
            tenant,
            state,
            action,
            action_kind,
            &action.event.pubkey.to_hex(),
            None,
        )
        .await;
    }
    if let Some(head) = &committed.head {
        dispatch_persistent_event(tenant, state, head, KIND_WEBSITE_HEAD, &relay_pubkey, None)
            .await;
    }
    dispatch_persistent_event(
        tenant,
        state,
        &committed.receipt,
        KIND_WEBSITE_RECEIPT,
        &relay_pubkey,
        None,
    )
    .await;
}

#[cfg(test)]
mod artifact_scope_tests {
    use super::*;

    const RELAY: &str = "wss://relay.example.com";
    const HASH: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    fn tenant() -> TenantContext {
        TenantContext::resolved(
            buzz_core::CommunityId::from_uuid(Uuid::from_u128(1)),
            "relay.example.com",
        )
    }

    #[test]
    fn canonical_same_tenant_media_url_returns_only_the_object_path() {
        let path = canonical_tenant_media_path(
            RELAY,
            &tenant(),
            &format!("https://relay.example.com/media/{HASH}.html"),
        )
        .expect("canonical URL should be accepted");
        let expected = format!("{HASH}.html");
        assert_eq!(path.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn canonical_media_url_rejects_query_credentials_and_wrong_origin() {
        for url in [
            format!("https://relay.example.com/media/{HASH}.html?download=1"),
            format!("https://user:pass@relay.example.com/media/{HASH}.html"),
            format!("https://relay.example.com/media/{HASH}.html#fragment"),
            format!("http://relay.example.com/media/{HASH}.html"),
        ] {
            assert_eq!(
                canonical_tenant_media_path(RELAY, &tenant(), &url),
                Err(WEBSITE_ARTIFACT_UNAVAILABLE.to_owned()),
                "{url}"
            );
        }
    }

    #[test]
    fn another_tenant_media_origin_remains_external_for_public_fetch_policy() {
        let path = canonical_tenant_media_path(
            RELAY,
            &tenant(),
            &format!("https://other.example.com/media/{HASH}.html"),
        )
        .expect("foreign URL is classified before the async tenant lookup");
        assert!(path.is_none());
    }
}
