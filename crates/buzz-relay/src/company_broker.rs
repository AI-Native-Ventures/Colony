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
    is_task_status_transition_allowed, validate_company, validate_company_update,
    validate_initiative, validate_initiative_update, validate_task, validate_task_update,
    CompanyProfile, CompanyTask, CompanyTeamRef, TaskStatus,
};
use buzz_core::kind::{
    KIND_COMPANY_ACTION, KIND_COMPANY_PROFILE, KIND_COMPANY_RECEIPT, KIND_INITIATIVE,
    KIND_SYSTEM_MESSAGE, KIND_TASK, KIND_TEAM,
};
use buzz_core::tenant::TenantContext;
use buzz_db::CompanyActionApply;
use buzz_sdk::company::{
    parse_company_action, parse_company_event, parse_initiative_event, parse_task_event,
    CompanyAction, CompanyActionOperation, CompanyActionPayload, CompanyReceiptOutcome,
};
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde::Serialize;
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
    // Every board dimension carries a single-letter mirror of its readable
    // tag (`c` company, `g` team, `w` status, `i` initiative, `s` stage, `u`
    // subject). Only single-letter tags are indexed — the nostr filter type
    // drops multi-letter keys before parsing — so without a mirror a value is
    // readable once you already have the event but unfilterable over the
    // wire, and "this run's tasks" is a question the relay cannot answer.
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
                // Mirror of the status in the signed content, spelled exactly
                // as it serialises there.
                scalar_tag("w", &serialized_slug(&initiative.status)?)?,
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
                // Mirror of `team`.
                scalar_tag("g", &task.owning_team_id)?,
                scalar_tag("cost-centre", &task.cost_centre_id)?,
                // Mirror of the status in the signed content.
                scalar_tag("w", &serialized_slug(&task.status)?)?,
            ];
            // One dependency edge per dependsOn entry. Repeated tags are how
            // "which tasks wait on X" becomes a single indexed filter instead
            // of a scan of every task head in the company.
            for dependency in &task.depends_on {
                tags.push(scalar_tag("v", dependency)?);
            }
            if let Some(initiative_id) = task.initiative_id.as_deref() {
                tags.push(scalar_tag("initiative", initiative_id)?);
                // Mirror of `initiative`.
                tags.push(scalar_tag("i", initiative_id)?);
            }
            if let Some(client) = task.client_organization_id.as_deref() {
                tags.push(scalar_tag("client", client)?);
            }
            if let Some(stage) = task.stage.as_deref() {
                // Mirror of the template stage slug: the kanban column key.
                tags.push(scalar_tag("s", stage)?);
            }
            if let Some(subject) = &task.subject {
                // Mirror of the subject as its `kind:ref` swimlane key.
                tags.push(scalar_tag(
                    "u",
                    &format!("{}:{}", serialized_slug(&subject.kind)?, subject.r#ref),
                )?);
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

/// The exact string a validated enum serialises to in head content.
///
/// Mirrors must spell statuses and subject kinds exactly as the signed
/// content does, or a filter for one status would match heads carrying
/// another. Deriving them through serde keeps that from drifting.
fn serialized_slug<T: Serialize>(value: &T) -> Result<String, String> {
    buzz_core::company::serde_enum_slug(value)
        .ok_or_else(|| "failed to derive single-letter tag value".to_string())
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

/// Upper bound on dependent heads examined for a single completion.
const MAX_READY_DERIVATION_CANDIDATES: usize = 1_000;

/// Decide whether one blocked task may wake given its dependencies' current
/// statuses, parallel to its `dependsOn` list. Pure so the diamond, replay,
/// and cancellation rules are testable without a database.
///
/// Ruling on terminal-bad dependencies: only `Completed` satisfies an edge.
/// A cancelled dependency leaves the dependent blocked rather than silently
/// claimable — work whose premise was deliberately killed must not become
/// assignable while the owner believes the branch is dead, and a blocked card
/// on the board is the visible prompt to resolve the branch by hand. Cascade
/// cancellation is a later phase.
fn dependent_is_ready_to_wake(
    dependent_status: TaskStatus,
    dependency_statuses: &[Option<TaskStatus>],
) -> bool {
    // No edges means nothing for completion to derive from: tasks without
    // dependencies reach ready the ordinary way and are never woken here.
    !dependency_statuses.is_empty()
        && dependent_status == TaskStatus::Blocked
        && dependency_statuses
            .iter()
            .all(|status| *status == Some(TaskStatus::Completed))
}

/// Current status of one relay-authored task head, if it exists.
async fn task_head_status(
    tenant: &TenantContext,
    state: &AppState,
    task_id: &str,
) -> Result<Option<TaskStatus>, String> {
    let Some(head) = load_head(tenant, state, KIND_TASK, task_id).await? else {
        return Ok(None);
    };
    parse_task_event(&head)
        .map(|task| Some(task.status))
        .map_err(|error| format!("stored task head {task_id} does not parse: {error}"))
}

/// Derive `blocked -> ready` for tasks waiting on a completed dependency.
///
/// Spec section 04: a blocked task becomes ready when EVERY task in its
/// `dependsOn` has reached a terminal-good state. Never fails the caller:
/// the owner's action already committed, so a hiccup here is logged and the
/// chain waits for the next completion instead of surfacing an error for a
/// write that did succeed.
async fn derive_ready_dependents(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    completed_task_id: &str,
) {
    if let Err(error) = derive_ready_dependents_inner(tenant, state, completed_task_id).await {
        tracing::warn!(completed_task_id, %error, "blocked-to-ready derivation failed");
    }
}

async fn derive_ready_dependents_inner(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    completed_task_id: &str,
) -> Result<(), String> {
    // Reachability: every head carries one `v` tag per dependsOn entry, so
    // the dependents of one completed task are exactly the heads carrying
    // that value — a GIN-served JSONB containment pushdown, not a scan of
    // every task head in the company.
    let candidates = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_TASK as i32]),
            global_only: true,
            tag_contains: Some(("v".to_string(), completed_task_id.to_string())),
            limit: Some(MAX_READY_DERIVATION_CANDIDATES as i64),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error finding dependents: {error}"))?;
    if candidates.len() == MAX_READY_DERIVATION_CANDIDATES {
        tracing::warn!(
            completed_task_id,
            candidates = candidates.len(),
            "dependency fan-in reached the derivation candidate bound"
        );
    }

    for stored in candidates {
        if let Err(error) =
            wake_dependent_if_ready(tenant, state, completed_task_id, &stored.event).await
        {
            tracing::warn!(
                dependent = %stored.event.id.to_hex(),
                %error,
                "skipped a dependent during blocked-to-ready derivation"
            );
        }
    }
    Ok(())
}

/// Attempt to wake ONE dependent candidate. `Ok(None)` means no wake was due
/// (already awake, dependencies unsatisfied); `Ok(Some(_))` means published;
/// `Err` means the candidate was unreadable or unwritable and was skipped.
async fn wake_dependent_if_ready(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    completed_task_id: &str,
    candidate_head: &Event,
) -> Result<Option<Event>, String> {
    let dependent = parse_task_event(candidate_head)
        .map_err(|error| format!("dependent head does not parse: {error}"))?;
    if !dependent
        .depends_on
        .contains(&completed_task_id.to_string())
    {
        // Stale snapshot: the candidate replaced this edge since the query ran.
        return Ok(None);
    }

    let mut dependency_statuses = Vec::with_capacity(dependent.depends_on.len());
    for dependency in &dependent.depends_on {
        dependency_statuses.push(task_head_status(tenant, state, dependency).await?);
    }
    if !dependent_is_ready_to_wake(dependent.status, &dependency_statuses) {
        return Ok(None);
    }

    // Re-read the current head instead of trusting the query snapshot: a
    // concurrent writer may have moved this coordinate since the filter ran.
    // Finding anything but Blocked means someone got there first, which is
    // what makes replays and racing diamonds converge to one wake.
    let previous_event = load_head(tenant, state, KIND_TASK, &dependent.id)
        .await?
        .ok_or_else(|| format!("dependent {} vanished before wake", dependent.id))?;
    let previous = parse_task_event(&previous_event)
        .map_err(|error| format!("dependent head does not parse on re-read: {error}"))?;
    if previous.status != TaskStatus::Blocked {
        return Ok(None);
    }

    let mut replacement = previous.clone();
    replacement.status = TaskStatus::Ready;
    // Only status and updatedAt differ from a head that passed full contract
    // validation when it was written; identity fields are untouched, so the
    // checks re-run here are exactly the ones the change could violate.
    replacement.updated_at = replacement
        .updated_at
        .max(chrono::Utc::now().timestamp())
        .max(previous.updated_at + 1);
    if !is_task_status_transition_allowed(
        previous.status,
        replacement.status,
        replacement.doer_kind,
    ) {
        return Ok(None);
    }

    // build_head re-derives every mirror (`w` becomes ready, `v` edges stay
    // identical) from the validated content, so the derived head is filtered
    // exactly like a hand-written one.
    let head = build_head(
        &state.relay_keypair,
        &CompanyActionPayload::Task(replacement),
        Some(&previous_event),
    )?;
    let (stored_head, inserted) = state
        .db
        .insert_event(tenant.community(), &head, None)
        .await
        .map_err(|error| format!("failed to store derived ready head: {error}"))?;
    if inserted {
        dispatch_persistent_event(
            tenant,
            state,
            &stored_head,
            KIND_TASK,
            &state.relay_keypair.public_key().to_hex(),
            None,
        )
        .await;
    }
    Ok(Some(head))
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
            // A committed task transition earns its thread row, and a task
            // reaching Completed may unblock downstream work. Both derive
            // after the commit and after dispatch so the completing write is
            // never delayed or failed by either; see
            // `emit_task_transition` and `derive_ready_dependents` for the
            // reachability and idempotency stories.
            if let CompanyActionPayload::Task(task) = &action.payload {
                let previous_status = match previous_head.as_ref() {
                    Some(head) => match parse_task_event(head) {
                        Ok(previous) => Some(previous.status),
                        Err(error) => {
                            tracing::warn!(
                                task_id = %task.id,
                                %error,
                                "previous task head unreadable; no transition row emitted"
                            );
                            None
                        }
                    },
                    None => None,
                };
                if let Some(transition) =
                    task_transition_event(action.operation, previous_status, task)
                {
                    emit_task_transition(tenant, state, transition, task).await;
                }
                if task.status == TaskStatus::Completed {
                    derive_ready_dependents(tenant, state, &task.id).await;
                }
            }
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

/// Which committed task actions earn a thread system row, and which kind.
///
/// Only seven moments are news to the thread: created, review handoff,
/// review rejected, bounce, completed, escalated, cancelled. Everything else
/// is board churn a status column already shows — a caption for
/// `ready -> inProgress` turns the thread into a status log and buries the
/// conversation under it. Bounce and escalation have no operation yet, so
/// they are deliberately absent from this decision rather than emitted
/// never; their desktop copy paths stay dormant until the model carries
/// them.
///
/// The decision keys off the ACTUAL state delta (`previous_status` versus
/// the replacement), not the action's declared verb: an Update that moves
/// status is a transition in effect. A replacement that changes no status is
/// a field edit and earns nothing.
fn task_transition_event(
    operation: CompanyActionOperation,
    previous_status: Option<TaskStatus>,
    replacement: &CompanyTask,
) -> Option<&'static str> {
    match (operation, previous_status) {
        (CompanyActionOperation::Create, None) => Some("task_created"),
        (_, Some(previous)) if previous != replacement.status => match replacement.status {
            TaskStatus::Completed => Some("task_completed"),
            TaskStatus::Cancelled => Some("task_cancelled"),
            TaskStatus::InReview if previous == TaskStatus::InProgress => {
                Some("task_review_handoff")
            }
            TaskStatus::InProgress if previous == TaskStatus::InReview => {
                Some("task_review_rejected")
            }
            _ => None,
        },
        _ => None,
    }
}

/// The exact payload `describeTaskTransition` on desktop parses. Optional
/// fields stay absent until a truthful source exists: nothing in the task
/// contract names a reviewer pubkey or an issue count today, and a row that
/// invents one would be wrong in the exact place people look for who did
/// what.
fn task_transition_payload(event_type: &str, task: &CompanyTask) -> serde_json::Value {
    json!({
        "type": event_type,
        "task": task.id,
        "title": task.title,
        "team": task.owning_team_id,
    })
}

/// Emit one kind 40099 system row for a committed task transition.
///
/// Scoped to where the work happens: the task's source channel, tagged into
/// its own thread with an `e` root marker when it has one — the same shape
/// ask receipts use — so a row never lands in a channel the task does not
/// belong to.
///
/// Best-effort exactly like every other post-commit side effect: the owner's
/// action is already durable when this runs, so any failure here is logged
/// and swallowed rather than surfaced against a write that succeeded.
///
/// Exactly-once comes from placement, not bookkeeping: this runs only inside
/// the `Applied` arm of one committed action, and a replayed idempotency key
/// short-circuits at the claim lookup long before any emission happens.
async fn emit_task_transition(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event_type: &str,
    task: &CompanyTask,
) {
    let content = match canonical_content(&task_transition_payload(event_type, task)) {
        Ok(content) => content,
        Err(error) => {
            tracing::warn!(task_id = %task.id, %error, "task transition payload build failed");
            return;
        }
    };
    let Ok(channel_id) = uuid::Uuid::parse_str(&task.source_channel_id) else {
        tracing::warn!(
            task_id = %task.id,
            channel = %task.source_channel_id,
            "task transition skipped: source channel is not a channel id"
        );
        return;
    };

    let mut tags = Vec::with_capacity(2);
    match Tag::parse(["h", channel_id.to_string().as_str()]) {
        Ok(tag) => tags.push(tag),
        Err(error) => {
            tracing::warn!(task_id = %task.id, %error, "task transition `h` tag build failed");
            return;
        }
    }
    if let Some(thread_root) = task.thread_root.as_deref() {
        match Tag::parse(["e", thread_root, "", "root"]) {
            Ok(tag) => tags.push(tag),
            Err(error) => {
                // The row still lands in the right channel; only the thread
                // scoping is lost, which the channel timeline renders anyway.
                tracing::warn!(
                    task_id = %task.id,
                    thread_root,
                    %error,
                    "task transition thread scope dropped"
                );
            }
        }
    }

    let event = match EventBuilder::new(Kind::Custom(KIND_SYSTEM_MESSAGE as u16), content)
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(task_id = %task.id, %error, "task transition sign failed");
            return;
        }
    };

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, Some(channel_id))
        .await
    {
        tracing::warn!(%error, channel_id = %channel_id, "task transition row store failed");
        return;
    }
    if let Err(error) = state
        .pubsub
        .publish_event(tenant, buzz_pubsub::EventTopic::Channel(channel_id), &event)
        .await
    {
        tracing::warn!(%error, "task transition row fan-out failed");
    }
}

/// Company mutations require the community's current human OWNER.///
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
    use buzz_sdk::company::CompanySdkError;

    fn scalar_tag_value<'a>(head: &'a Event, name: &str) -> Option<&'a str> {
        head.tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
            .map(|tag| tag.as_slice()[1].as_str())
            .next()
    }

    fn scalar_tag_values<'a>(head: &'a Event, name: &str) -> Vec<&'a str> {
        head.tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
            .map(|tag| tag.as_slice()[1].as_str())
            .collect()
    }

    fn tag_count(head: &Event, name: &str) -> usize {
        head.tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some(name))
            .count()
    }

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
            status: buzz_core::company::TaskStatus::InProgress,
            owning_team_id: "team-marketing".to_string(),
            assignee_persona_ids: vec!["builtin:content".to_string()],
            qa_persona_id: "builtin:marketing-lead".to_string(),
            cost_centre_id: "internal".to_string(),
            commercial_purpose: buzz_core::company::CommercialPurpose::Marketing,
            client_organization_id: Some("acme-corp".to_string()),
            source_channel_id: "general".to_string(),
            source_event_id: None,
            implicit: false,
            depends_on: vec!["write-homepage-brief".to_string()],
            subject: Some(buzz_core::company::SubjectRef {
                kind: buzz_core::company::SubjectKind::Party,
                r#ref: "acme-lead".to_string(),
            }),
            stage: Some("build-site".to_string()),
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
        // The status mirror is present exactly once and spells the status
        // exactly as the signed content does.
        assert_eq!(tag_count(&initiative_head, "w"), 1);
        assert_eq!(scalar_tag_value(&initiative_head, "w"), Some("proposed"));

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

        // Single-letter mirrors: exactly one each, spelled as the content
        // spells them. `inProgress` proves the mirror is serde-derived rather
        // than lowercased by hand.
        for (name, expected) in [
            ("g", "team-marketing"),
            ("i", "init-homepage"),
            ("s", "build-site"),
            ("u", "party:acme-lead"),
            ("w", "inProgress"),
            ("v", "write-homepage-brief"),
        ] {
            assert_eq!(tag_count(&task_head, name), 1);
            assert_eq!(
                scalar_tag_value(&task_head, name),
                Some(expected),
                "mirror `{name}` must match the signed content"
            );
        }
    }

    /// One `v` tag per dependency entry: two edges on the content, two tags
    /// on the head, each naming a declared dependency. This repetition is
    /// what makes "dependents of X" an indexed filter later.
    #[test]
    fn every_dependency_emits_its_own_edge_tag() {
        let relay = Keys::generate();
        let mut task = sample_task();
        task.depends_on = vec![
            "write-homepage-brief".to_string(),
            "approve-budget".to_string(),
        ];
        let head =
            build_head(&relay, &CompanyActionPayload::Task(task), None).expect("build task head");
        assert_eq!(tag_count(&head, "v"), 2);
        assert_eq!(scalar_tag_values(&head, "v").len(), 2);
        for edge in ["write-homepage-brief", "approve-budget"] {
            assert!(
                scalar_tag_values(&head, "v").contains(&edge),
                "dependency {edge} must have its own `v` tag"
            );
        }
        parse_task_event(&head).expect("multi-edge head parses");
    }

    /// A Task with no initiative and no client must omit both optional tags;
    /// emitting them empty would fail the strict parser. The same discipline
    /// applies to the optional mirrors `i`, `s` and `u`, while the mirrors of
    /// required fields (`g` team, `w` status) stay present. An empty
    /// dependsOn emits no `v` edges at all.
    #[test]
    fn task_head_omits_absent_optional_coordinates() {
        let relay = Keys::generate();
        let mut task = sample_task();
        task.initiative_id = None;
        task.client_organization_id = None;
        task.stage = None;
        task.subject = None;
        task.depends_on = Vec::new();

        let head =
            build_head(&relay, &CompanyActionPayload::Task(task), None).expect("build task head");
        for name in ["initiative", "client", "i", "s", "u", "v"] {
            assert!(
                !head.tags.iter().any(|tag| tag.as_slice()[0] == name),
                "absent `{name}` must not produce a tag"
            );
        }
        assert_eq!(tag_count(&head, "g"), 1);
        assert_eq!(tag_count(&head, "w"), 1);
        let parsed = parse_task_event(&head).expect("parse task head");
        assert_eq!(parsed.initiative_id, None);
        assert_eq!(parsed.client_organization_id, None);
        assert_eq!(parsed.stage, None);
        assert_eq!(parsed.subject, None);
        assert_eq!(parsed.depends_on, Vec::<String>::new());
    }

    /// A mirror that disagrees with the signed content must be refused: the
    /// whole point of an index is that clients filter on it instead of the
    /// content, so it may never say something the content does not.
    #[test]
    fn lying_single_letter_mirrors_are_refused() {
        let relay = Keys::generate();
        let mut head = build_head(&relay, &CompanyActionPayload::Task(sample_task()), None)
            .expect("build task head");
        head.tags = head
            .tags
            .into_iter()
            .map(|tag| {
                if tag.as_slice().first().map(String::as_str) == Some("w") {
                    Tag::parse(["w", "completed"]).expect("tag parses")
                } else {
                    tag
                }
            })
            .collect();
        let error = parse_task_event(&head).expect_err("lying status mirror must be refused");
        assert!(matches!(error, CompanySdkError::TagContentMismatch("task")));
    }

    /// Heads written before the mirrors existed carry none of them and must
    /// still parse: absent mirrors mean the content stays authoritative, not
    /// that the head is broken. The content is also rolled back to the
    /// pre-chain shape (empty dependsOn) so edges and list agree the way a
    /// genuinely old head's would.
    #[test]
    fn heads_written_before_mirrors_existed_still_parse() {
        let relay = Keys::generate();
        let mut task = sample_task();
        task.depends_on = Vec::new();
        let mut head =
            build_head(&relay, &CompanyActionPayload::Task(task), None).expect("build task head");
        head.tags.retain(|tag| {
            !matches!(
                tag.as_slice().first().map(String::as_str),
                Some("g" | "i" | "s" | "u" | "w" | "v")
            )
        });
        let parsed = parse_task_event(&head).expect("pre-mirror head parses");
        assert_eq!(parsed.owning_team_id, "team-marketing");
        assert_eq!(parsed.status, buzz_core::company::TaskStatus::InProgress);
        assert_eq!(parsed.initiative_id.as_deref(), Some("init-homepage"));
    }

    /// A dependency edge the content does not declare must be refused with
    /// the same force as a lying status: dependents of a task are found by
    /// filtering `v`, so an invented edge would wake work that never waited.
    #[test]
    fn lying_dependency_edges_are_refused() {
        let relay = Keys::generate();
        let mut head = build_head(&relay, &CompanyActionPayload::Task(sample_task()), None)
            .expect("build task head");
        head.tags = head
            .tags
            .into_iter()
            .map(|tag| {
                if tag.as_slice().first().map(String::as_str) == Some("v") {
                    Tag::parse(["v", "some-other-task"]).expect("tag parses")
                } else {
                    tag
                }
            })
            .collect();
        let error = parse_task_event(&head).expect_err("lying edge must be refused");
        assert!(matches!(error, CompanySdkError::TagContentMismatch("task")));
    }

    /// Diamond: D waits on B and C, both complete in sequence. After B only,
    /// D must stay blocked; after C, exactly the one remaining check passes.
    /// A replay or racing duplicate finds D no longer Blocked and does
    /// nothing — the status guard IS the once-only guarantee.
    #[test]
    fn diamond_wakes_exactly_when_the_last_dependency_completes() {
        // After B completes: C still running, D stays blocked.
        let after_b = [Some(TaskStatus::Completed), Some(TaskStatus::InProgress)];
        assert!(!dependent_is_ready_to_wake(TaskStatus::Blocked, &after_b));
        // After C completes: every edge terminal-good, D wakes.
        let after_c = [Some(TaskStatus::Completed), Some(TaskStatus::Completed)];
        assert!(dependent_is_ready_to_wake(TaskStatus::Blocked, &after_c));
        // A second derivation pass against an already-woken D does nothing.
        assert!(!dependent_is_ready_to_wake(TaskStatus::Ready, &after_c));
    }

    /// Terminal-bad dependencies never manufacture claimable work: a
    /// cancelled upstream leaves the dependent visibly blocked for the owner
    /// to resolve, and an unresolvable dependency blocks just the same.
    #[test]
    fn cancelled_and_missing_dependencies_never_wake_a_task() {
        let cancelled = [Some(TaskStatus::Completed), Some(TaskStatus::Cancelled)];
        assert!(!dependent_is_ready_to_wake(TaskStatus::Blocked, &cancelled));
        let missing_upstream = [Some(TaskStatus::Completed), None];
        assert!(!dependent_is_ready_to_wake(
            TaskStatus::Blocked,
            &missing_upstream
        ));
        assert!(!dependent_is_ready_to_wake(TaskStatus::Blocked, &[]));
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

    /// The seven thread moments and nothing else. Every edge here is
    /// reachable through `is_task_status_transition_allowed`, so the rows the
    /// decision emits are exactly the ones that can happen today.
    #[test]
    fn only_the_seven_thread_moments_produce_a_transition_row() {
        use buzz_core::company::{DoerKind, TaskStatus};

        // Creation is news.
        assert_eq!(
            task_transition_event(CompanyActionOperation::Create, None, &sample_task()),
            Some("task_created")
        );

        let handoff = sample_task();
        let mut rejected = handoff.clone();
        rejected.status = TaskStatus::InReview;
        assert_eq!(
            task_transition_event(
                CompanyActionOperation::Transition,
                Some(TaskStatus::InProgress),
                &rejected,
            ),
            Some("task_review_handoff")
        );
        assert_eq!(
            task_transition_event(
                CompanyActionOperation::Transition,
                Some(TaskStatus::InReview),
                &handoff,
            ),
            Some("task_review_rejected")
        );

        let mut completed = handoff.clone();
        completed.status = TaskStatus::Completed;
        assert_eq!(
            task_transition_event(
                CompanyActionOperation::Transition,
                Some(TaskStatus::InReview),
                &completed,
            ),
            Some("task_completed")
        );
        // A human finishing their own work completes from inProgress too.
        let mut human_done = completed.clone();
        human_done.doer_kind = DoerKind::Human;
        assert_eq!(
            task_transition_event(
                CompanyActionOperation::Transition,
                Some(TaskStatus::InProgress),
                &human_done,
            ),
            Some("task_completed")
        );

        let mut cancelled = handoff.clone();
        cancelled.status = TaskStatus::Cancelled;
        for previous in [
            TaskStatus::Proposed,
            TaskStatus::Ready,
            TaskStatus::InProgress,
            TaskStatus::Blocked,
            TaskStatus::Snoozed,
        ] {
            assert_eq!(
                task_transition_event(
                    CompanyActionOperation::Transition,
                    Some(previous),
                    &cancelled,
                ),
                Some("task_cancelled"),
                "cancellation from {previous:?} is thread news"
            );
        }

        // Board churn earns nothing: ordinary claiming, blocking, parking,
        // waking, and field edits on a live task.
        let mut churned = handoff.clone();
        for (from, to) in [
            (TaskStatus::Proposed, TaskStatus::Ready),
            (TaskStatus::Ready, TaskStatus::InProgress),
            (TaskStatus::Ready, TaskStatus::Blocked),
            (TaskStatus::InProgress, TaskStatus::Blocked),
            (TaskStatus::Blocked, TaskStatus::Ready),
            (TaskStatus::Snoozed, TaskStatus::Ready),
        ] {
            churned.status = to;
            assert_eq!(
                task_transition_event(CompanyActionOperation::Update, Some(from), &churned,),
                None,
                "{from:?} -> {to:?} is board churn, not thread news"
            );
        }

        // A replacement that changes no status is a field edit.
        let mut untouched = handoff.clone();
        untouched.title = "Renamed".to_string();
        assert_eq!(
            task_transition_event(
                CompanyActionOperation::Update,
                Some(handoff.status),
                &untouched,
            ),
            None
        );
    }

    /// The payload is the exact contract `describeTaskTransition` parses:
    /// required keys always present, optional keys honestly absent until a
    /// truthful source exists.
    #[test]
    fn transition_payload_matches_the_desktop_contract() {
        let payload = task_transition_payload("task_completed", &sample_task());
        assert_eq!(payload["type"], "task_completed");
        assert_eq!(payload["task"], "task-copy");
        assert_eq!(payload["title"], "Write homepage copy");
        assert_eq!(payload["team"], "team-marketing");
        // No reviewer pubkey or issue count exists on the task contract yet;
        // absent beats invented. The desktop parser treats both as optional
        // and renders without them (its tests cover the absent paths).
        assert!(payload.get("reviewer").is_none());
        assert!(payload.get("issues").is_none());
        assert!(payload.get("reason").is_none());

        // And it survives canonicalization, which is what gets signed into
        // the system message content.
        let content = canonical_content(&task_transition_payload("task_created", &sample_task()))
            .expect("canonicalize transition payload");
        let round: serde_json::Value =
            serde_json::from_str(&content).expect("canonical content is JSON");
        assert_eq!(round["type"], "task_created");
    }
}
