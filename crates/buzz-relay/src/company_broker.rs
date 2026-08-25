//! Relay-owned broker for owner-authorized Colony company mutations.
//!
//! Company, Initiative, and Task heads are NIP-33 parameterized-replaceable
//! events, and the author is part of the coordinate. If desktop identities
//! signed them directly, transferring community ownership would mint a second
//! coordinate for the same logical record — two competing "current" heads with
//! no way to reconcile them. So the tenant relay key is the only author, and an
//! owner authorizes a change by signing a `KIND_COMPANY_ACTION` request instead.
//!
//! This module turns one such request into a relay-signed head plus a
//! relay-signed receipt, or into a receipt alone when the request loses.
//!
//! Rejections split deliberately:
//!
//! - Malformed envelopes, the wrong relay, and non-owners are refused with no
//!   storage at all. Anyone can send those, so persisting one record per
//!   attempt would be a spam surface.
//! - A well-formed request from the actual owner that loses on validation or
//!   compare-and-set gets a durable receipt, because the owner needs an
//!   auditable answer and a retry needs to find the original outcome.

use std::sync::Arc;

use buzz_core::company::{
    validate_company, validate_company_update, validate_initiative, validate_initiative_update,
    validate_task, validate_task_update, CompanyProfile, CompanyTeamRef,
};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_INITIATIVE, KIND_TASK,
    KIND_TEAM,
};
use buzz_core::tenant::TenantContext;
use buzz_db::CompanyActionApply;
use buzz_sdk::company::{
    parse_company_action, parse_company_event, parse_initiative_event, parse_task_event,
    CompanyAction, CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde_json::json;

use crate::handlers::event::dispatch_persistent_event;
use crate::state::AppState;

const RECEIPT_SCHEMA: &str = "colony.company-receipt/v1";

/// What ingest should report back to the requesting client.
pub(crate) enum CompanyBrokerOutcome {
    /// Action, head, and receipt committed and were dispatched.
    Applied,
    /// Another signed request already owns this community-scoped retry key.
    Duplicate {
        /// Raw event ID of the action that originally won the claim.
        original_action_event_id: Vec<u8>,
    },
    /// The owner's request lost. A failure receipt was stored and dispatched.
    Refused {
        /// Display-safe reason, already scrubbed of private company state.
        message: String,
    },
}

/// Whether this event is a Company Action and belongs to this broker.
///
/// Deliberately kind-only: a malformed Company Action must reach the strict
/// parser and be rejected there, not fall through to generic event storage.
pub(crate) fn is_company_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_COMPANY_ACTION
}

fn scalar_tag(name: &str, value: &str) -> Result<Tag, String> {
    Tag::parse([name, value]).map_err(|error| format!("failed to build `{name}` tag: {error}"))
}

fn canonical_content(value: &serde_json::Value) -> Result<String, String> {
    buzz_core::block::canonical_json(value)
        .map_err(|error| format!("failed to canonicalize company content: {error}"))
}

/// The `created_at` a replacement head must carry.
///
/// NIP-33 keeps the newer event at a coordinate, so a replacement written in
/// the same second as the head it replaces loses the comparison and the write
/// is refused. That is not a rare race: an owner walking an initiative from
/// proposed to approved to active does it in well under a second, and every
/// rung after the first would fail. The relay authors these heads, so the
/// ordering guarantee is the relay's to keep — one second past the previous
/// head when the clock has not moved on by itself.
fn head_timestamp(previous_head: Option<&Event>) -> nostr::Timestamp {
    let now = nostr::Timestamp::now();
    match previous_head {
        Some(previous) if previous.created_at >= now => previous.created_at + 1u64,
        _ => now,
    }
}

/// Rebuild head tags from validated CONTENT, never from the client's request.
///
/// The action carries a target coordinate, but trusting its tags would let a
/// requester point a validated payload at someone else's coordinate.
fn build_head(
    relay: &Keys,
    payload: &CompanyActionPayload,
    previous_head: Option<&Event>,
) -> Result<Event, String> {
    // Every head carries `c` alongside the readable `company` tag. Only
    // single-letter tags are indexed, so `#company` is a filter the relay
    // never receives: the nostr filter type drops it before parsing, and a
    // client asking for one company's records gets every company's. `c` is
    // what makes that question answerable where the records are.
    let (kind, tags, content) = match payload {
        CompanyActionPayload::Company(profile) => {
            let tags = vec![
                scalar_tag("d", &profile.id)?,
                scalar_tag("c", &profile.id)?,
                scalar_tag("company", &profile.id)?,
            ];
            (KIND_COMPANY_PROFILE, tags, serde_json::to_value(profile))
        }
        CompanyActionPayload::Initiative(initiative) => {
            let mut tags = vec![
                scalar_tag("d", &initiative.id)?,
                scalar_tag("c", &initiative.company_id)?,
                scalar_tag("company", &initiative.company_id)?,
                scalar_tag("cost-centre", &initiative.cost_centre_id)?,
            ];
            if let Some(client) = initiative.client_organization_id.as_deref() {
                tags.push(scalar_tag("client", client)?);
            }
            (KIND_INITIATIVE, tags, serde_json::to_value(initiative))
        }
        CompanyActionPayload::Task(task) => {
            let mut tags = vec![
                scalar_tag("d", &task.id)?,
                scalar_tag("c", &task.company_id)?,
                scalar_tag("company", &task.company_id)?,
                scalar_tag("team", &task.owning_team_id)?,
                scalar_tag("cost-centre", &task.cost_centre_id)?,
            ];
            if let Some(initiative_id) = task.initiative_id.as_deref() {
                tags.push(scalar_tag("initiative", initiative_id)?);
            }
            if let Some(client) = task.client_organization_id.as_deref() {
                tags.push(scalar_tag("client", client)?);
            }
            (KIND_TASK, tags, serde_json::to_value(task))
        }
    };
    let content =
        content.map_err(|error| format!("failed to serialize company payload: {error}"))?;
    EventBuilder::new(Kind::Custom(kind as u16), canonical_content(&content)?)
        .tags(tags)
        .custom_created_at(head_timestamp(previous_head))
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign company head: {error}"))
}

/// Build the exact four-tag relay-signed receipt the SDK parser accepts.
fn build_receipt(
    relay: &Keys,
    action_event: &Event,
    action: &CompanyAction,
    outcome: CompanyReceiptOutcome,
    head_event_id: Option<&str>,
) -> Result<Event, String> {
    let content = canonical_content(&json!({
        "schema": RECEIPT_SCHEMA,
        "headEventId": head_event_id,
    }))?;
    let tags = vec![
        scalar_tag("p", &action_event.pubkey.to_hex())?,
        Tag::parse(["e", &action_event.id.to_hex(), "", "company-action"])
            .map_err(|error| format!("failed to build receipt `e` tag: {error}"))?,
        scalar_tag("a", &action.target)?,
        Tag::parse([
            "company-receipt",
            "1",
            &action.request_id.to_string(),
            &action.idempotency_key.to_string(),
            outcome.as_tag_value(),
        ])
        .map_err(|error| format!("failed to build `company-receipt` tag: {error}"))?,
    ];
    EventBuilder::new(Kind::Custom(KIND_COMPANY_RECEIPT as u16), content)
        .tags(tags)
        .sign_with_keys(relay)
        .map_err(|error| format!("failed to sign company receipt: {error}"))
}

/// Load one head by coordinate under an explicit author.
async fn load_head_authored_by(
    tenant: &TenantContext,
    state: &AppState,
    kind: u32,
    d_tag: &str,
    author: &nostr::PublicKey,
    reader: Option<&nostr::PublicKey>,
) -> Result<Option<Event>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![kind as i32]),
            pubkey: Some(author.to_bytes().to_vec()),
            d_tag: Some(d_tag.to_owned()),
            global_only: true,
            limit: Some(1),
            // Reference resolution can name a client-authored Persona under an
            // arbitrary author, so it must honour the same unshared-persona
            // visibility gate every other read path enforces. Without it the
            // owner gains an existence-and-version oracle on other members'
            // private personas.
            shared_gated_reader: reader.map(|key| key.to_bytes().to_vec()),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading company head: {error}"))?;
    Ok(rows.into_iter().next().map(|stored| stored.event))
}

/// Load one relay-authored canonical head by coordinate, if it exists.
async fn load_head(
    tenant: &TenantContext,
    state: &AppState,
    kind: u32,
    d_tag: &str,
) -> Result<Option<Event>, String> {
    // Canonical heads are relay-authored and never persona-gated.
    load_head_authored_by(
        tenant,
        state,
        kind,
        d_tag,
        &state.relay_keypair.public_key(),
        None,
    )
    .await
}

/// Upper bound on team rows considered when validating one Task.
///
/// The query is already scoped to a single author, so this only guards against
/// a pathological store. Without a bound the DB's silent 1000-row clamp would
/// apply under `ORDER BY created_at DESC` and could push the real owning team
/// out of the window, turning a valid Task into `MissingReference`.
const MAX_TEAM_REFS: usize = 500;

/// Project stored Team events into the validation-only shape `buzz-core` uses
/// to check Task ownership and QA membership.
///
/// Scoped to the ACTING OWNER's own Team events. Kind 30176 is client-authored
/// with no content validation at ingest, so an unscoped read would let any
/// ordinary member publish a Team at an existing `d` tag and inject a duplicate
/// id — `validate_teams` rejects duplicates, which would break every Task
/// action in the community from an unprivileged account.
///
/// Teams that cannot satisfy the Task contract are skipped rather than passed
/// through as invalid entries, using `buzz-core`'s own `validate_team_ref` so
/// the two sets cannot diverge. `validate_teams` requires a lead that is also a
/// member, so a lead-less team — which the desktop ships for both built-in
/// teams — has no valid representation here. Passing one through would fail
/// validation for the WHOLE list, breaking every Task action in the community;
/// skipping keeps the failure scoped to a Task that actually names such a team.
async fn load_team_refs(
    tenant: &TenantContext,
    state: &AppState,
    owner_pubkey: &nostr::PublicKey,
) -> Result<Vec<CompanyTeamRef>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_TEAM as i32]),
            pubkey: Some(owner_pubkey.to_bytes().to_vec()),
            global_only: true,
            limit: Some(MAX_TEAM_REFS as i64),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error loading teams: {error}"))?;

    #[derive(serde::Deserialize)]
    struct TeamContent {
        #[serde(default)]
        persona_ids: Option<Vec<String>>,
        #[serde(default)]
        lead_persona_id: Option<String>,
    }

    let mut teams: Vec<CompanyTeamRef> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    for stored in rows {
        let Some(id) = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
        }) else {
            continue;
        };
        // Rows arrive newest-first, so the first row for a `d` tag is the live
        // NIP-33 head; ignore anything superseded.
        if !seen_ids.insert(id.clone()) {
            continue;
        }
        // Content that will not parse cannot authorize ownership; skip it
        // rather than failing every company action in the community.
        let Ok(content) = serde_json::from_str::<TeamContent>(&stored.event.content) else {
            continue;
        };
        let (Some(lead_persona_id), Some(persona_ids)) =
            (content.lead_persona_id, content.persona_ids)
        else {
            continue;
        };
        let candidate = CompanyTeamRef {
            id,
            lead_persona_id,
            persona_ids,
        };
        // Filter on exactly the conditions `validate_teams` rejects on, using
        // its own single-team validator, so the skip set cannot drift from the
        // reject set. Any gap between them turns one unusable team into a
        // whole-list failure for every Task action in the community.
        if buzz_core::company::validate_team_ref(&candidate).is_err() {
            continue;
        }
        teams.push(candidate);
    }
    Ok(teams)
}

/// Validate the requested payload against current canonical state.
///
/// Returns the display-safe reason a request loses. Messages stay generic
/// about *values* so a receipt cannot leak private company state.
async fn validate_payload_against_state(
    tenant: &TenantContext,
    state: &AppState,
    action: &CompanyAction,
    action_author: nostr::PublicKey,
    previous_head: Option<&Event>,
) -> Result<(), String> {
    match &action.payload {
        CompanyActionPayload::Company(profile) => {
            validate_company(profile).map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_company_event(previous)
                    .map_err(|error| format!("stored company head is unreadable: {error}"))?;
                validate_company_update(&previous, profile).map_err(|error| error.to_string())?;
            }
        }
        CompanyActionPayload::Initiative(initiative) => {
            let company = load_company(tenant, state, &initiative.company_id).await?;
            validate_initiative(initiative, &company).map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_initiative_event(previous)
                    .map_err(|error| format!("stored initiative head is unreadable: {error}"))?;
                validate_initiative_update(&previous, initiative, &company)
                    .map_err(|error| error.to_string())?;
            }
        }
        CompanyActionPayload::Task(task) => {
            let company = load_company(tenant, state, &task.company_id).await?;
            let initiative = match task.initiative_id.as_deref() {
                Some(initiative_id) => {
                    let head = load_head(tenant, state, KIND_INITIATIVE, initiative_id)
                        .await?
                        .ok_or_else(|| "referenced initiative does not exist".to_owned())?;
                    Some(parse_initiative_event(&head).map_err(|error| {
                        format!("stored initiative head is unreadable: {error}")
                    })?)
                }
                None => None,
            };
            let teams = load_team_refs(tenant, state, &action_author).await?;
            validate_task(task, &company, initiative.as_ref(), &teams)
                .map_err(|error| error.to_string())?;
            if let Some(previous) = previous_head {
                let previous = parse_task_event(previous)
                    .map_err(|error| format!("stored task head is unreadable: {error}"))?;
                validate_task_update(&previous, task, &company, initiative.as_ref(), &teams)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

async fn load_company(
    tenant: &TenantContext,
    state: &AppState,
    company_id: &str,
) -> Result<CompanyProfile, String> {
    let head = load_head(tenant, state, KIND_COMPANY_PROFILE, company_id)
        .await?
        .ok_or_else(|| "referenced company does not exist".to_owned())?;
    parse_company_event(&head)
        .map_err(|error| format!("stored company head is unreadable: {error}"))
}

/// Verify every compare-and-set reference the action declared still resolves.
///
/// References may name relay-authored company heads OR client-authored Persona
/// and Team coordinates — checking that a Task's team membership has not
/// changed underneath the request is the main reason the field exists. So the
/// author comes from the coordinate itself rather than being pinned to the
/// relay key; pinning it would make every Persona/Team reference unresolvable
/// and silently kill the feature.
async fn validate_expected_references(
    tenant: &TenantContext,
    state: &AppState,
    action: &CompanyAction,
    action_author: nostr::PublicKey,
) -> Result<(), String> {
    for reference in &action.expected_references {
        let mut parts = reference.target.splitn(3, ':');
        let kind = parts
            .next()
            .and_then(|raw| raw.parse::<u32>().ok())
            .ok_or_else(|| "expected reference has an invalid coordinate".to_owned())?;
        let author = parts
            .next()
            .and_then(|raw| nostr::PublicKey::from_hex(raw).ok())
            .ok_or_else(|| "expected reference has an invalid coordinate".to_owned())?;
        let d_tag = parts
            .next()
            .ok_or_else(|| "expected reference has an invalid coordinate".to_owned())?;
        let head = load_head_authored_by(tenant, state, kind, d_tag, &author, Some(&action_author))
            .await?
            .ok_or_else(|| "an expected reference no longer resolves".to_owned())?;
        if head.id.to_hex() != reference.event_id {
            return Err("an expected reference changed since the request".to_owned());
        }
    }
    Ok(())
}

/// Broker one owner-signed Company Action.
///
/// `Err` means "refuse without storing": malformed, wrong relay, or not the
/// owner. Everything the owner legitimately requested resolves to an outcome
/// with a durable receipt.
pub(crate) async fn handle_company_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<CompanyBrokerOutcome, String> {
    // Canonical company heads are only as trustworthy as the key that signs
    // them. Without BUZZ_RELAY_PRIVATE_KEY the relay falls back to a hardcoded
    // development key that every install shares, so anyone could forge a head
    // for any community. Chat tolerates that fallback; commercial and
    // accounting state must not.
    if state.config.relay_private_key.is_none() {
        return Err(
            "company actions require a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        );
    }

    let action = parse_company_action(action_event).map_err(|error| error.to_string())?;
    if action.relay_pubkey != state.relay_keypair.public_key().to_hex() {
        return Err("company action `p` tag must target this relay".into());
    }

    // Leaving the generic command branch also left behind its `ensure_user`.
    // `create_community_with_owner` writes only `relay_members`, so a brand-new
    // community's owner has no `users` row and both humanity checks would refuse
    // their very first Company Action — which is exactly the onboarding path.
    state
        .db
        .ensure_user(tenant.community(), &action_event.pubkey.to_bytes())
        .await
        .map_err(|error| format!("database error registering company actor: {error}"))?;

    authorize_company_actor(tenant, state, action_event).await?;

    let payload_kind = match &action.payload {
        CompanyActionPayload::Company(_) => KIND_COMPANY_PROFILE,
        CompanyActionPayload::Initiative(_) => KIND_INITIATIVE,
        CompanyActionPayload::Task(_) => KIND_TASK,
    };
    let entity_id = match &action.payload {
        CompanyActionPayload::Company(profile) => profile.id.clone(),
        CompanyActionPayload::Initiative(initiative) => initiative.id.clone(),
        CompanyActionPayload::Task(task) => task.id.clone(),
    };
    let previous_head = load_head(tenant, state, payload_kind, &entity_id).await?;

    // A retry has to be answered before the create-vs-replace contract is
    // checked. The first attempt already created the record, so checking that
    // contract first refuses the second attempt as "that record already
    // exists" — which is exactly the case a derived idempotency key exists to
    // make safe. A client that lost its answer to a dropped connection would
    // have no way to find out it had actually succeeded.
    if let Some(claim) = state
        .db
        .find_company_action_claim(tenant.community(), action.idempotency_key)
        .await
        .map_err(|error| format!("company action claim lookup failed: {error}"))?
    {
        return replay_claim(state, tenant, action_event, &action, &claim).await;
    }

    // Everything past this point is a legitimate owner request, so a loss is
    // reported through a stored receipt rather than a bare error.
    if let Err(message) = check_expectations(&action, previous_head.as_ref()) {
        return refuse(state, tenant, action_event, &action, message).await;
    }
    if let Err(message) =
        validate_expected_references(tenant, state, &action, action_event.pubkey).await
    {
        return refuse(state, tenant, action_event, &action, message).await;
    }
    if let Err(message) = validate_payload_against_state(
        tenant,
        state,
        &action,
        action_event.pubkey,
        previous_head.as_ref(),
    )
    .await
    {
        return refuse(state, tenant, action_event, &action, message).await;
    }

    let head = build_head(
        &state.relay_keypair,
        &action.payload,
        previous_head.as_ref(),
    )?;
    let receipt = build_receipt(
        &state.relay_keypair,
        action_event,
        &action,
        CompanyReceiptOutcome::Applied,
        Some(&head.id.to_hex()),
    )?;
    let expected_head_id = previous_head
        .as_ref()
        .map(|event| event.id.as_bytes().to_vec());

    match state
        .db
        .apply_company_action_once(
            tenant.community(),
            action_event,
            &head,
            &entity_id,
            &receipt,
            action.idempotency_key,
            &action_event.pubkey.to_hex(),
            expected_head_id.as_deref(),
        )
        .await
        .map_err(|error| format!("failed to apply company action atomically: {error}"))?
    {
        CompanyActionApply::Applied {
            action: stored_action,
            head: stored_head,
            receipt: stored_receipt,
        } => {
            let relay_pubkey = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &stored_action,
                KIND_COMPANY_ACTION,
                &action_event.pubkey.to_hex(),
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &stored_head,
                payload_kind,
                &relay_pubkey,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &stored_receipt,
                KIND_COMPANY_RECEIPT,
                &relay_pubkey,
                None,
            )
            .await;
            Ok(CompanyBrokerOutcome::Applied)
        }
        CompanyActionApply::Duplicate {
            original_action_event_id,
        } => Ok(CompanyBrokerOutcome::Duplicate {
            original_action_event_id,
        }),
        // Authority can change between the pre-check and the commit. The
        // transaction re-checks both halves — an owner row AND a non-agent
        // identity — under `FOR UPDATE`, so it really is the authority of
        // record and its verdict stands.
        CompanyActionApply::NotOwner => {
            Err("company actions require the current community owner".into())
        }
        // The signature is spent: this exact action was already stored, which
        // only happens after it was refused. `refuse` is idempotent here — the
        // action insert fails, so it stores nothing and re-reports the loss.
        CompanyActionApply::ActionAlreadyStored => {
            refuse(
                state,
                tenant,
                action_event,
                &action,
                "this request was already processed; sign a new one to retry".to_owned(),
            )
            .await
        }
        CompanyActionApply::StaleHead { .. } => {
            refuse(
                state,
                tenant,
                action_event,
                &action,
                "the record changed since this request was prepared".to_owned(),
            )
            .await
        }
    }
}

/// Answer a retry with the outcome its first attempt already produced.
///
/// Deliberately not a refusal. From the client's side this attempt succeeded,
/// because the work it asked for is done; reporting a conflict would push it
/// to change the request, and changing an approval is the one thing it must
/// not do.
async fn replay_claim(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    action: &CompanyAction,
    claim: &buzz_db::CompanyActionClaim,
) -> Result<CompanyBrokerOutcome, String> {
    tracing::info!(
        idempotency_key = %action.idempotency_key,
        retry_event = %action_event.id.to_hex(),
        "company action retried; replaying the original outcome"
    );
    let _ = (state, tenant);
    Ok(CompanyBrokerOutcome::Duplicate {
        original_action_event_id: claim.action_event_id.clone(),
    })
}

/// Enforce the create-vs-replace contract against what is actually stored.
fn check_expectations(action: &CompanyAction, previous_head: Option<&Event>) -> Result<(), String> {
    match (action.operation, previous_head) {
        (CompanyActionOperation::Create, Some(_)) => Err("that record already exists".to_owned()),
        (CompanyActionOperation::Update | CompanyActionOperation::Transition, None) => {
            Err("that record does not exist yet".to_owned())
        }
        (CompanyActionOperation::Create, None) => Ok(()),
        (CompanyActionOperation::Update | CompanyActionOperation::Transition, Some(head)) => {
            match action.expected_head.as_deref() {
                Some(expected) if expected == head.id.to_hex() => Ok(()),
                _ => Err("the record changed since this request was prepared".to_owned()),
            }
        }
    }
}

/// Store and dispatch a conflict receipt for a legitimate owner request.
async fn refuse(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    action_event: &Event,
    action: &CompanyAction,
    message: String,
) -> Result<CompanyBrokerOutcome, String> {
    let receipt = build_receipt(
        &state.relay_keypair,
        action_event,
        action,
        CompanyReceiptOutcome::Conflict,
        None,
    )?;
    let stored = state
        .db
        .store_company_failure_receipt(tenant.community(), action_event, &receipt)
        .await
        .map_err(|error| format!("failed to store company failure receipt: {error}"))?;
    if let Some((stored_action, stored_receipt)) = stored {
        let relay_pubkey = state.relay_keypair.public_key().to_hex();
        dispatch_persistent_event(
            tenant,
            state,
            &stored_action,
            KIND_COMPANY_ACTION,
            &action_event.pubkey.to_hex(),
            None,
        )
        .await;
        dispatch_persistent_event(
            tenant,
            state,
            &stored_receipt,
            KIND_COMPANY_RECEIPT,
            &relay_pubkey,
            None,
        )
        .await;
    }
    Ok(CompanyBrokerOutcome::Refused { message })
}

/// Company mutations require the community's current human OWNER.
///
/// Deliberately stricter than the Block catalog broker, which also accepts
/// admins: company state carries commercial and accounting authority, and the
/// corrected design makes owner identity the single authorization anchor.
/// This is a fast pre-check for a clear error message. The binding decision is
/// made under `FOR UPDATE` inside the mutation transaction, which enforces the
/// same owner-and-human pair, so removing this pre-check would degrade the
/// error message but not the authorization.
async fn authorize_company_actor(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
) -> Result<(), String> {
    let member = state
        .db
        .get_relay_member(tenant.community(), &event.pubkey.to_hex())
        .await
        .map_err(|error| format!("database error checking company authority: {error}"))?
        .ok_or_else(|| "company actions require the community owner".to_owned())?;
    let actor = state
        .db
        .get_agent_channel_policy(tenant.community(), event.pubkey.as_bytes())
        .await
        .map_err(|error| format!("database error checking company actor type: {error}"))?
        .ok_or_else(|| "company actions require a registered human owner".to_owned())?;
    if member.role != "owner" || actor.1.is_some() {
        return Err("company actions require a human community owner".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::company::{CompanyOnboardingStatus, CompanyService, CostCentre, CostCentreKind};

    fn sample_company() -> CompanyProfile {
        CompanyProfile {
            schema: "colony.company/v1".to_string(),
            id: "horizon-labs".to_string(),
            trading_name: "Horizon Labs".to_string(),
            legal_name: None,
            website: None,
            summary: "Digital services".to_string(),
            business_type: "agency".to_string(),
            services: vec![CompanyService {
                id: "web".to_string(),
                name: "Web".to_string(),
                description: "Websites".to_string(),
            }],
            customer_segments: vec!["smb".to_string()],
            cost_centres: vec![CostCentre {
                id: "internal".to_string(),
                name: "Internal".to_string(),
                kind: CostCentreKind::Internal,
                service_id: None,
            }],
            source_report_event_id: None,
            onboarding_status: CompanyOnboardingStatus::Draft,
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    #[test]
    fn only_company_action_kind_reaches_this_broker() {
        let event = EventBuilder::new(Kind::Custom(KIND_COMPANY_ACTION as u16), "{}")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert!(is_company_action_candidate(&event));

        let other = EventBuilder::new(Kind::Custom(KIND_TASK as u16), "{}")
            .sign_with_keys(&Keys::generate())
            .expect("sign");
        assert!(!is_company_action_candidate(&other));
    }

    /// The head the relay signs must round-trip through the SDK's strict
    /// parser, or clients could never read what the relay writes.
    /// A replacement head must be strictly newer than the head it replaces.
    ///
    /// Found live rather than in review: starting an initiative walks proposed
    /// to approved to active in well under a second, so every rung after the
    /// first was refused with "company head lost NIP-33 replacement ordering"
    /// and the feature did not work at all.
    #[test]
    fn a_replacement_head_is_always_newer_than_the_head_it_replaces() {
        let relay = Keys::generate();
        let first = build_head(
            &relay,
            &CompanyActionPayload::Company(sample_company()),
            None,
        )
        .expect("build first head");
        let mut changed = sample_company();
        changed.trading_name = "Renamed".to_string();
        changed.updated_at += 1;
        let second = build_head(
            &relay,
            &CompanyActionPayload::Company(changed),
            Some(&first),
        )
        .expect("build replacement head");

        assert!(
            second.created_at > first.created_at,
            "a replacement written in the same second as its predecessor loses NIP-33 ordering"
        );

        // And a third in the same breath keeps climbing.
        let mut again = sample_company();
        again.trading_name = "Renamed Again".to_string();
        again.updated_at += 2;
        let third = build_head(&relay, &CompanyActionPayload::Company(again), Some(&second))
            .expect("build third head");
        assert!(third.created_at > second.created_at);
    }

    #[test]
    fn relay_authored_company_head_round_trips_through_the_strict_parser() {
        let relay = Keys::generate();
        let head = build_head(
            &relay,
            &CompanyActionPayload::Company(sample_company()),
            None,
        )
        .expect("build head");

        assert_eq!(head.kind.as_u16() as u32, KIND_COMPANY_PROFILE);
        assert_eq!(head.pubkey, relay.public_key());
        assert!(
            !head.tags.iter().any(|tag| tag.as_slice()[0] == "h"),
            "company heads are community-global and never carry `h`"
        );
        let parsed = parse_company_event(&head).expect("parse relay head");
        assert_eq!(parsed.id, "horizon-labs");
    }

    /// A create must not be accepted when a head already exists, and a
    /// replacement must name the exact head it replaces.
    #[test]
    fn create_and_replace_expectations_are_enforced_against_stored_state() {
        let relay = Keys::generate();
        let head = build_head(
            &relay,
            &CompanyActionPayload::Company(sample_company()),
            None,
        )
        .expect("build head");
        let mut action = CompanyAction {
            relay_pubkey: relay.public_key().to_hex(),
            operation: CompanyActionOperation::Create,
            request_id: uuid::Uuid::new_v4(),
            idempotency_key: uuid::Uuid::new_v4(),
            target: format!(
                "{KIND_COMPANY_PROFILE}:{}:horizon-labs",
                relay.public_key().to_hex()
            ),
            expected_head: None,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Company(sample_company()),
        };

        assert!(check_expectations(&action, None).is_ok());
        assert!(check_expectations(&action, Some(&head)).is_err());

        action.operation = CompanyActionOperation::Update;
        action.expected_head = Some(head.id.to_hex());
        assert!(check_expectations(&action, Some(&head)).is_ok());
        assert!(check_expectations(&action, None).is_err());

        action.expected_head = Some("f".repeat(64));
        assert!(
            check_expectations(&action, Some(&head)).is_err(),
            "a replacement naming the wrong head must lose"
        );
    }

    fn sample_initiative() -> buzz_core::company::Initiative {
        buzz_core::company::Initiative {
            schema: "colony.initiative/v1".to_string(),
            id: "init-homepage".to_string(),
            company_id: "horizon-labs".to_string(),
            title: "Homepage refresh".to_string(),
            summary: "Rebuild the marketing site".to_string(),
            status: buzz_core::company::InitiativeStatus::Proposed,
            owner_persona_id: "builtin:fizz".to_string(),
            cost_centre_id: "internal".to_string(),
            commercial_purpose: buzz_core::company::CommercialPurpose::Marketing,
            client_organization_id: None,
            expected_cost_usd: Some(120.0),
            source_channel_id: "general".to_string(),
            source_event_id: None,
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    fn sample_task() -> buzz_core::company::CompanyTask {
        buzz_core::company::CompanyTask {
            schema: "colony.task/v1".to_string(),
            id: "task-copy".to_string(),
            company_id: "horizon-labs".to_string(),
            initiative_id: Some("init-homepage".to_string()),
            title: "Write homepage copy".to_string(),
            status: buzz_core::company::TaskStatus::Proposed,
            owning_team_id: "team-marketing".to_string(),
            assignee_persona_ids: vec!["builtin:content".to_string()],
            qa_persona_id: "builtin:marketing-lead".to_string(),
            cost_centre_id: "internal".to_string(),
            commercial_purpose: buzz_core::company::CommercialPurpose::Marketing,
            client_organization_id: Some("acme-corp".to_string()),
            source_channel_id: "general".to_string(),
            source_event_id: None,
            implicit: false,
            depends_on: Vec::new(),
            subject: None,
            stage: None,
            thread_root: None,
            doer_kind: buzz_core::company::DoerKind::Agent,
            wake_at: None,
            created_at: 1_000,
            updated_at: 1_000,
        }
    }

    /// The relay signs these heads; if their tag sets do not match what the
    /// strict parsers require, the relay commits a head no client can read —
    /// and the damage only surfaces on the NEXT update, which has to parse it.
    #[test]
    fn relay_authored_initiative_and_task_heads_round_trip() {
        let relay = Keys::generate();

        let initiative_head = build_head(
            &relay,
            &CompanyActionPayload::Initiative(sample_initiative()),
            None,
        )
        .expect("build initiative head");
        assert_eq!(initiative_head.kind.as_u16() as u32, KIND_INITIATIVE);
        assert!(!initiative_head
            .tags
            .iter()
            .any(|tag| tag.as_slice()[0] == "h"));
        let parsed = parse_initiative_event(&initiative_head).expect("parse initiative head");
        assert_eq!(parsed.id, "init-homepage");
        assert_eq!(parsed.cost_centre_id, "internal");
        // No client on this initiative, so the optional tag must be absent.
        assert!(!initiative_head
            .tags
            .iter()
            .any(|tag| tag.as_slice()[0] == "client"));

        let task_head = build_head(&relay, &CompanyActionPayload::Task(sample_task()), None)
            .expect("build task head");
        assert_eq!(task_head.kind.as_u16() as u32, KIND_TASK);
        assert!(!task_head.tags.iter().any(|tag| tag.as_slice()[0] == "h"));
        let parsed = parse_task_event(&task_head).expect("parse task head");
        assert_eq!(parsed.owning_team_id, "team-marketing");
        assert_eq!(parsed.initiative_id.as_deref(), Some("init-homepage"));
        assert_eq!(parsed.client_organization_id.as_deref(), Some("acme-corp"));

        // Both optional tags present exactly once when the payload carries them.
        for name in ["initiative", "client"] {
            assert_eq!(
                task_head
                    .tags
                    .iter()
                    .filter(|tag| tag.as_slice()[0] == name)
                    .count(),
                1,
                "task head must carry exactly one `{name}` tag"
            );
        }
    }

    /// A Task with no initiative and no client must omit both optional tags;
    /// emitting them empty would fail the strict parser.
    #[test]
    fn task_head_omits_absent_optional_coordinates() {
        let relay = Keys::generate();
        let mut task = sample_task();
        task.initiative_id = None;
        task.client_organization_id = None;

        let head =
            build_head(&relay, &CompanyActionPayload::Task(task), None).expect("build task head");
        for name in ["initiative", "client"] {
            assert!(
                !head.tags.iter().any(|tag| tag.as_slice()[0] == name),
                "absent `{name}` must not produce a tag"
            );
        }
        let parsed = parse_task_event(&head).expect("parse task head");
        assert_eq!(parsed.initiative_id, None);
        assert_eq!(parsed.client_organization_id, None);
    }

    #[test]
    fn receipt_round_trips_and_an_applied_receipt_names_its_head() {
        let relay = Keys::generate();
        let owner = Keys::generate();
        let head = build_head(
            &relay,
            &CompanyActionPayload::Company(sample_company()),
            None,
        )
        .expect("build head");
        let action = CompanyAction {
            relay_pubkey: relay.public_key().to_hex(),
            operation: CompanyActionOperation::Create,
            request_id: uuid::Uuid::new_v4(),
            idempotency_key: uuid::Uuid::new_v4(),
            target: format!(
                "{KIND_COMPANY_PROFILE}:{}:horizon-labs",
                relay.public_key().to_hex()
            ),
            expected_head: None,
            expected_references: Vec::new(),
            payload: CompanyActionPayload::Company(sample_company()),
        };
        let action_event = buzz_sdk::company::build_company_action(&action)
            .expect("build action")
            .sign_with_keys(&owner)
            .expect("sign action");

        let applied = build_receipt(
            &relay,
            &action_event,
            &action,
            CompanyReceiptOutcome::Applied,
            Some(&head.id.to_hex()),
        )
        .expect("applied receipt");
        let parsed = buzz_sdk::company::parse_company_receipt(&applied).expect("parse receipt");
        assert_eq!(parsed.outcome, CompanyReceiptOutcome::Applied);
        assert_eq!(
            parsed.head_event_id.as_deref(),
            Some(head.id.to_hex().as_str())
        );
        assert_eq!(parsed.actor_pubkey, owner.public_key().to_hex());
        assert_eq!(parsed.action_event_id, action_event.id.to_hex());

        let conflict = build_receipt(
            &relay,
            &action_event,
            &action,
            CompanyReceiptOutcome::Conflict,
            None,
        )
        .expect("conflict receipt");
        let parsed = buzz_sdk::company::parse_company_receipt(&conflict).expect("parse receipt");
        assert_eq!(parsed.outcome, CompanyReceiptOutcome::Conflict);
        assert_eq!(parsed.head_event_id, None);
    }
}
