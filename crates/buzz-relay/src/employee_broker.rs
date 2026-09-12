//! Hiring and updating: turning a community owner's requests into, and
//! about, workspace employees.
//!
//! An employee is a role the company employs, not a process a member runs.
//! The relay mints and holds its keypair so every member can produce work as
//! one colleague without a private key being copied between laptops
//! (`docs/design/company-employees.html`).
//!
//! Hiring (kind 9045) runs as a side effect, which the ingest path treats as
//! best effort: it may run more than once for the same request and its
//! errors are logged, not returned to the client. Both properties are
//! designed for rather than tolerated. Hiring is keyed on the request event,
//! so a repeat run recognises its own prior work and re-publishes the head
//! instead of minting a second identity for one role. The manager edge on a
//! hire is validated here before the row is written, for the same reason:
//! the request itself is best-effort, so a bad edge must be refused where it
//! can still be surfaced -- and since a refused hire simply does not happen,
//! nothing invalid is ever stored.
//!
//! Employee updates (kind 9046: rank, reporting line, retirement) are the
//! opposite split, deliberately. Every rule is enforced at INGEST in
//! [`enforce_employee_update`], which returns errors to the client, because
//! a silently dropped promotion would leave an owner staring at an unchanged
//! org chart; the side effect ([`handle_employee_update`]) then applies what
//! ingest already authorized. It re-runs the same enforcement first, so the
//! mutation can never apply through a path that skipped the checks.

use std::sync::Arc;

use buzz_core::employee::{
    parse_employee_update, parse_hire_request, ParsedEmployeeUpdate, ParsedHireRequest,
};
use buzz_core::interrupt::AgentTier;
use buzz_core::kind::{KIND_ASK_RESOLUTION, KIND_EMPLOYEE, KIND_MANAGED_AGENT};
use buzz_core::tenant::TenantContext;
use buzz_db::asks::AskRow;
use nostr::{Event, EventBuilder, Keys, Kind, PublicKey, Tag};
use tracing::{info, warn};

use crate::employee_key::EmployeeKeyError;
use crate::interrupt_gate::agent_tier;
use crate::state::AppState;
use buzz_pubsub::EventTopic;

/// What hiring did, so the caller can log one line that says which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HireOutcome {
    /// A new employee was minted and its head published.
    Hired,
    /// This request had already produced an employee; the head was
    /// re-published so a lost fan-out heals.
    AlreadyHired,
    /// The role is already filled by a different employee.
    RoleTaken,
}

/// What an employee update did, so the caller can log one line that says
/// which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// The row changed and the head was republished.
    Updated,
    /// The row was retired. No head republishes: status lives on the row.
    Retired,
    /// The target had no active row -- already retired between validation
    /// and application, or gone entirely. A settled no-op, not an error.
    NoActiveRow,
}

/// Hire an employee for `event`, an owner's hire request.
///
/// Refuses rather than guesses when the signer is not a community owner,
/// when no sealing key is configured, or when the request is malformed: an
/// employee nobody authorized is worse than a hire that did not happen.
pub async fn handle_hire_request(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<HireOutcome, String> {
    let request =
        parse_hire_request(event).map_err(|error| format!("invalid hire request: {error}"))?;

    // Only a community owner may add to the payroll. Checked against the
    // relay's own membership table rather than anything in the event, so a
    // forged tag cannot promote its author.
    let signer_hex = event.pubkey.to_hex();
    let is_owner = state
        .db
        .get_relay_member(tenant.community(), &signer_hex)
        .await
        .map_err(|error| format!("database error checking hire authority: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !is_owner {
        return Err(format!(
            "hire refused: {signer_hex} is not an owner of this community"
        ));
    }

    // Validate the requested reporting line before anything is written. The
    // request is a best-effort side effect, so this refusal would otherwise
    // never reach anyone; refusing here means an invalid edge cannot even
    // reach the row, and the CLI's own pre-parse of the request catches the
    // shape errors before the network round trip.
    let manager_bytes = if request.rank == AgentTier::Executive {
        if request.manager.is_some() {
            return Err("hire refused: executives carry no manager".to_string());
        }
        None
    } else {
        match &request.manager {
            Some(manager_hex) => {
                validate_manager_for_rank(
                    tenant,
                    state,
                    request.rank,
                    manager_hex,
                    // Self-reference is unrepresentable on the hire path: the
                    // employee's keypair is minted below, after this check.
                    None,
                )
                .await?;
                Some(hex::decode(manager_hex).map_err(|_| {
                    "internal error: a validated hex64 field failed to decode".to_string()
                })?)
            }
            None => None,
        }
    };

    let sealer = state
        .employee_key_sealer
        .as_ref()
        .ok_or_else(|| EmployeeKeyError::NotConfigured.to_string())?;

    let hire_event_bytes = event.id.as_bytes().to_vec();

    // Idempotence: a re-run finds its own prior employee and republishes the
    // head rather than minting a second identity for the same request.
    if let Some(existing) = state
        .db
        .find_employee_by_hire_event(tenant.community(), &hire_event_bytes)
        .await
        .map_err(|error| format!("database error looking up prior hire: {error}"))?
    {
        let keys = open_employee_keys(state, tenant, &existing.pubkey, &existing.sealed_key)?;
        republish_employee_head(tenant, state, &keys, &existing).await;
        return Ok(HireOutcome::AlreadyHired);
    }

    // Mint independently of the relay's own keypair. Deriving from it would
    // make every dev install share employee identities, because the dev relay
    // key is a repo constant.
    let keys = Keys::generate();
    let pubkey_bytes = keys.public_key().to_bytes().to_vec();
    let secret: [u8; 32] = keys.secret_key().to_secret_bytes();
    let employee_pubkey: [u8; 32] = keys.public_key().to_bytes();
    let sealed = sealer
        .seal(*tenant.community().as_uuid(), &employee_pubkey, &secret)
        .map_err(|error| format!("could not seal the employee key: {error}"))?;

    let inserted = state
        .db
        .insert_employee(
            tenant.community(),
            buzz_db::employees::NewEmployee {
                pubkey: &pubkey_bytes,
                sealed_key: &sealed,
                role_id: &request.role_id,
                display_name: &request.display_name,
                rank: request.rank.as_str(),
                hired_by: &event.pubkey.to_bytes(),
                hire_event: &hire_event_bytes,
                manager: manager_bytes.as_deref(),
            },
        )
        .await
        .map_err(|error| format!("database error recording the hire: {error}"))?;

    // `None` means a unique index refused the row. The hire-event index is
    // handled above, so reaching here means the role is already filled.
    let Some(_row) = inserted else {
        return Ok(HireOutcome::RoleTaken);
    };

    publish_head_for_new_hire(tenant, state, &keys, &request, &signer_hex, event).await;
    info!(
        role = %request.role_id,
        employee = %keys.public_key().to_hex(),
        "employee hired"
    );

    // The hire may be the answer to an agent's `hiring` ask. Closing it here
    // is what makes the existing wake-up receipt fire, so the agent that
    // asked resumes where it stalled instead of waiting to be told by hand.
    // Best effort, like everything else on this path: the employee exists
    // either way, and a missed wake-up is recoverable.
    resolve_hiring_ask_for_hire(tenant, state, event, HireOutcome::Hired, &request, &keys).await;

    Ok(HireOutcome::Hired)
}

/// The escalation category a hire answers. Asks filed under it are the ones
/// a completed hire may close.
const HIRING_CATEGORY: &str = "hiring";

/// Pick the ask a completed hire answers, or `None` to leave every ask open.
///
/// Pure, so the whole rule is testable without a database. In order:
///
/// - The hire must actually have HIRED someone. `AlreadyHired` means this
///   request was already processed (its ask, if any, was closed then), and
///   `RoleTaken` means nothing was hired at all.
/// - `explicit` -- the still-open ask named by an `e` tag on the hire
///   request -- wins outright. An `e` tag naming a closed or unknown ask
///   arrives here as `None` and falls through to the fallback, because a
///   stale pointer is not a reason to leave a live ask hanging.
/// - Otherwise the fallback closes an ask only when the open `hiring` asks
///   addressed to this owner number EXACTLY one. Zero means there is
///   nothing to answer; more than one means we cannot tell which was
///   answered, and closing the wrong hiring request is worse than the owner
///   nudging the right agent once.
fn select_hiring_ask(
    outcome: HireOutcome,
    explicit: Option<AskRow>,
    candidates: Vec<AskRow>,
) -> Option<AskRow> {
    if outcome != HireOutcome::Hired {
        return None;
    }
    if let Some(explicit) = explicit {
        return Some(explicit);
    }
    match candidates.len() {
        1 => candidates.into_iter().next(),
        _ => None,
    }
}

/// Close the hiring ask this hire answers, then wake the agent that filed
/// it -- the same three steps a human resolution takes
/// (`ask_broker::handle_resolution`): a relay-signed kind 44301, a
/// conditional `resolve_ask` claim, and `emit_ask_receipt` into the ask's
/// origin thread.
///
/// Every failure is logged and swallowed. The hire itself is already
/// durable by the time this runs, and an ask that stays open can still be
/// answered by hand; nothing here may undo employment.
///
/// Idempotence comes from two places: this only runs on
/// [`HireOutcome::Hired`], which a repeat of the same request never
/// produces, and `resolve_ask` is a conditional `UPDATE ... WHERE status =
/// 'open'`, so two relays racing the same hire produce exactly one
/// resolution.
async fn resolve_hiring_ask_for_hire(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    hire_event: &Event,
    outcome: HireOutcome,
    request: &ParsedHireRequest,
    employee_keys: &Keys,
) {
    // Same requirement resolution already carries: without a durable relay
    // key every install shares the fallback dev key, and a forgeable "your
    // ask was resolved" receipt is worse than no receipt.
    if state.config.relay_private_key.is_none() {
        warn!(
            "hire did not resolve a hiring ask: no durable relay signing key \
             (set BUZZ_RELAY_PRIVATE_KEY)"
        );
        return;
    }

    let explicit = match explicit_open_ask(tenant, state, hire_event).await {
        Ok(explicit) => explicit,
        Err(error) => {
            warn!(error = %error, "hire: failed to look up the ask named by the request");
            return;
        }
    };
    let candidates = match state
        .db
        .find_open_asks_by_category_and_audience(
            tenant.community(),
            HIRING_CATEGORY,
            &hire_event.pubkey.to_bytes(),
        )
        .await
    {
        Ok(candidates) => candidates,
        Err(error) => {
            warn!(error = %error, "hire: failed to load open hiring asks for this owner");
            return;
        }
    };
    let candidate_count = candidates.len();

    let Some(row) = select_hiring_ask(outcome, explicit, candidates) else {
        info!(
            candidate_count,
            "hire resolved no ask: no unambiguous open hiring ask to close"
        );
        return;
    };

    let ask_event_hex = hex::encode(&row.ask_event_id);
    let answer = serde_json::json!({
        "hired": {
            "role": request.role_id,
            "name": request.display_name,
            "pubkey": employee_keys.public_key().to_hex(),
        }
    });
    let content = serde_json::json!({
        "answer": answer,
        "default_executed": false,
    })
    .to_string();
    let tag = match Tag::parse(["e", &ask_event_hex]) {
        Ok(tag) => tag,
        Err(error) => {
            warn!(error = %error, "hire: failed to build the resolution `e` tag");
            return;
        }
    };
    let resolution = match EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![tag])
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(resolution) => resolution,
        Err(error) => {
            warn!(error = %error, "hire: failed to sign the ask resolution");
            return;
        }
    };

    // Claim the row before any side effect, exactly as the sweep's
    // default-execution path does: a lost race means someone else already
    // closed this ask and there is nothing left to wake.
    let flipped = match state
        .db
        .resolve_ask(
            tenant.community(),
            &row.ask_event_id,
            resolution.id.as_bytes(),
            &hire_event.pubkey.to_bytes(),
            false,
        )
        .await
    {
        Ok(flipped) => flipped,
        Err(error) => {
            warn!(error = %error, "hire: failed to resolve the hiring ask");
            return;
        }
    };
    if !flipped {
        return;
    }

    // The ask's outcome just changed: close its deadline head so no client
    // keeps counting down toward a deadline that can no longer fire.
    crate::ask_state_head::publish_closed_head(
        tenant,
        state,
        &row.ask_event_id,
        &crate::ask_state_head::AskClosure::Resolved {
            default_executed: false,
            default_option: None,
        },
    )
    .await;

    // Relay-authored, so it bypasses ingest: store it here the way the
    // interrupt sweep stores its own resolutions, and keep it best effort --
    // the ask is already durably resolved above.
    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &resolution, None)
        .await
    {
        warn!(error = %error, "hire: failed to store the ask resolution event");
    }

    info!(ask = %ask_event_hex, "hire resolved the hiring ask it answers");

    let Some(origin_thread) = &row.origin_thread else {
        return;
    };
    let filer = match PublicKey::from_slice(&row.filer_pubkey) {
        Ok(filer) => filer,
        Err(error) => {
            warn!(error = %error, "hire: stored filer pubkey is not valid, cannot wake it");
            return;
        }
    };
    let ask_channel_id = match state
        .db
        .get_event_by_id(tenant.community(), &row.ask_event_id)
        .await
    {
        Ok(stored) => stored.and_then(|stored| stored.channel_id),
        Err(error) => {
            warn!(error = %error, "hire: failed to load the ask event to wake its filer");
            return;
        }
    };
    crate::ask_broker::emit_ask_receipt(
        tenant,
        state,
        &hex::encode(origin_thread),
        &format!(
            "Hired {} as {}. You asked for this; you can carry on.",
            request.display_name, request.role_id
        ),
        filer,
        ask_channel_id,
    )
    .await;
}

/// The still-OPEN ask named by an `e` tag on the hire request, if any.
///
/// `None` covers every "no exact link" case the fallback then handles: no
/// `e` tag, a duplicated or malformed one, and a tag naming an ask that is
/// unknown to this community or already closed.
async fn explicit_open_ask(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    hire_event: &Event,
) -> Result<Option<AskRow>, String> {
    let tag = match buzz_core::event_tags::optional_tag(hire_event, "e") {
        Ok(Some(tag)) => tag,
        Ok(None) => return Ok(None),
        Err(_) => {
            warn!("hire: the request carries more than one `e` tag; ignoring the exact link");
            return Ok(None);
        }
    };
    let Ok(ask_event_id) = hex::decode(&tag) else {
        warn!(tag = %tag, "hire: the request's `e` tag is not hex; ignoring the exact link");
        return Ok(None);
    };
    let row = state
        .db
        .find_open_ask_by_event_id(tenant.community(), &ask_event_id)
        .await
        .map_err(|error| error.to_string())?;
    if row.is_none() {
        warn!(
            ask = %tag,
            "hire: the request names an ask that is closed or unknown here; \
             falling back to the unambiguous open hiring ask, if there is one"
        );
    }
    Ok(row)
}

/// Enforce every rule a kind 9046 update must satisfy, at INGEST time, so
/// refusals reach the owner instead of vanishing in a best-effort side
/// effect. Returns the parsed request when the update may proceed.
///
/// Rules, in order: signer is a current community owner; target exists and
/// is active; a retirement names no reports; a resulting manager sits
/// exactly one rung above the resulting rank and is not the employee
/// itself; a rank change leaves no current report stranded below its
/// escalation target. Fails closed on database errors.
pub async fn enforce_employee_update(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<ParsedEmployeeUpdate, String> {
    let parsed = parse_employee_update(event)
        .map_err(|error| format!("invalid employee update: {error}"))?;

    // Only a current community owner may change the payroll, checked against
    // the membership table like every other owner-authority decision here.
    let signer_hex = event.pubkey.to_hex();
    let is_owner = state
        .db
        .get_relay_member(tenant.community(), &signer_hex)
        .await
        .map_err(|error| format!("database error checking update authority: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !is_owner {
        return Err(format!(
            "update refused: {signer_hex} is not an owner of this community"
        ));
    }

    let target_bytes = hex::decode(&parsed.pubkey_hex)
        .map_err(|_| "internal error: a validated hex64 field failed to decode".to_string())?;
    let Some(employee) = state
        .db
        .find_employee(tenant.community(), &target_bytes)
        .await
        .map_err(|error| format!("database error loading the employee: {error}"))?
    else {
        return Err(format!(
            "update refused: {} is not an employee of this community",
            parsed.pubkey_hex
        ));
    };
    if employee.status != "active" {
        return Err(format!(
            "update refused: {} is already retired",
            parsed.pubkey_hex
        ));
    }

    // An employee Colony provides is not the workspace's to retire, rename,
    // re-rank or re-line. Colony maintains it, and the next bundled version
    // is what changes it. Refused here, at ingest, so the owner sees why
    // rather than watching an update quietly do nothing.
    if employee.provisioned_handle.is_some() {
        let verb = if parsed.retire { "retired" } else { "changed" };
        return Err(format!(
            "{} is provided by Colony and cannot be {verb}.",
            employee.display_name
        ));
    }
    let target = PublicKey::from_slice(&target_bytes)
        .map_err(|_| "internal error: stored employee pubkey is not valid".to_string())?;

    if parsed.retire {
        let reports = direct_reports(tenant, state, &target).await?;
        if !reports.is_empty() {
            let names = reports
                .iter()
                .map(|pubkey| pubkey.to_hex())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "retire refused: {names} still report to {}; reassign them first",
                parsed.pubkey_hex
            ));
        }
        return Ok(parsed);
    }

    // The rank the employee ends up with: the requested one, or today's.
    let current_rank = AgentTier::parse(&employee.rank)
        .ok_or_else(|| "internal error: stored employee rank does not parse".to_string())?;
    let new_rank = parsed.rank.unwrap_or(current_rank);

    if new_rank == AgentTier::Executive {
        // An executive carries no manager, ever. A request trying to SET one
        // alongside the promotion is refused; an existing manager is dropped
        // implicitly, because there is no separate "clear" wire format and
        // refusing would deadlock promote-after-demote flows.
        if parsed.manager.is_some() {
            return Err("update refused: executives carry no manager".to_string());
        }
    } else {
        // The manager the employee ends up with: the requested one, or --
        // when only the rank moved -- the existing line, re-checked against
        // the new rank. A demotion out from under an invalid existing edge
        // is refused with the fix named, not applied silently.
        let effective_manager = match &parsed.manager {
            Some(manager_hex) => Some(manager_hex.clone()),
            None => employee.manager.as_deref().map(hex::encode),
        };
        if let Some(manager_hex) = effective_manager {
            validate_manager_for_rank(tenant, state, new_rank, &manager_hex, Some(&target)).await?;
        }
    }

    // Delete protection across rank changes: nobody still reporting to this
    // employee may end up pointing one rung BELOW where the employee now
    // sits. Runs whenever a rank change is requested, so a promotion passes
    // trivially and a demotion that would orphan a report names it.
    if parsed.rank.is_some() && parsed.rank != Some(current_rank) {
        let reports = direct_reports(tenant, state, &target).await?;
        let mut stranded: Vec<String> = Vec::new();
        for report in &reports {
            // Fail closed: a DB error resolving a report's tier refuses the
            // update rather than waving it through.
            match agent_tier(tenant, state, report).await? {
                Some(report_tier) if report_tier.escalation_target() == new_rank => {}
                other => stranded.push(format!(
                    "{} ({})",
                    report.to_hex(),
                    other
                        .map(|tier| tier.as_str().to_string())
                        .unwrap_or_else(|| "no resolvable tier".to_string())
                )),
            }
        }
        if !stranded.is_empty() {
            return Err(format!(
                "update refused: demoting {} to {} would leave {} without a valid \
                 escalation path; move them first ({})",
                parsed.pubkey_hex,
                new_rank.as_str(),
                if stranded.len() == 1 {
                    "them"
                } else {
                    "each of them"
                },
                stranded.join(", ")
            ));
        }
    }

    Ok(parsed)
}

/// Apply an owner-signed kind 9046 update: change the employees row, then
/// republish the 30190 head from the ROW's state.
///
/// Re-runs [`enforce_employee_update`] first, so the mutation can never
/// apply through a path that skipped ingest-time validation. Row first,
/// then head: `agent_tier` and `agent_manager` read the row BEFORE any
/// event, so authority must never trail the paper record -- the reverse
/// order would briefly show clients a head the gate does not yet believe.
/// Both land before this function returns; a crash between them leaves the
/// authoritative row correct and the next update heals the head.
pub async fn handle_employee_update(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<UpdateOutcome, String> {
    let parsed = enforce_employee_update(tenant, state, event).await?;

    let target_bytes = hex::decode(&parsed.pubkey_hex)
        .map_err(|_| "internal error: a validated hex64 field failed to decode".to_string())?;

    if parsed.retire {
        state
            .db
            .update_employee(
                tenant.community(),
                &target_bytes,
                None,
                None,
                Some("retired"),
            )
            .await
            .map_err(|error| format!("database error retiring the employee: {error}"))?;
        info!(employee = %parsed.pubkey_hex, "employee retired");
        return Ok(UpdateOutcome::Retired);
    }

    // `Some(None)` clears the column exactly when the promotion reaches the
    // top of the ladder; see `enforce_employee_update` for why clearing is
    // implicit there.
    let decoded_manager =
        match &parsed.manager {
            Some(manager_hex) => Some(hex::decode(manager_hex).map_err(|_| {
                "internal error: a validated hex64 field failed to decode".to_string()
            })?),
            None => None,
        };
    let manager_update: Option<Option<&[u8]>> = match (&decoded_manager, parsed.rank) {
        (Some(bytes), _) => Some(Some(bytes.as_slice())),
        // Promoting to the top of the ladder clears any existing line.
        (None, Some(AgentTier::Executive)) => Some(None),
        (None, _) => None,
    };
    let new_rank_str = parsed.rank.map(|tier| tier.as_str());

    let Some(updated) = state
        .db
        .update_employee(
            tenant.community(),
            &target_bytes,
            new_rank_str,
            manager_update,
            None,
        )
        .await
        .map_err(|error| format!("database error updating the employee: {error}"))?
    else {
        return Ok(UpdateOutcome::NoActiveRow);
    };

    let keys = open_employee_keys(state, tenant, &updated.pubkey, &updated.sealed_key)?;
    republish_employee_head(tenant, state, &keys, &updated).await;
    info!(
        employee = %parsed.pubkey_hex,
        rank = %updated.rank,
        "employee updated"
    );
    Ok(UpdateOutcome::Updated)
}

/// Whether `manager_hex` may be the manager of an agent at `new_rank`: it
/// must resolve to a real agent in THIS community whose tier is exactly the
/// rank's escalation target, and (when `subject` is given, i.e. on updates)
/// must not be the subject itself. Executives are handled by the callers:
/// they carry no manager, so this function is only reached for ranks that
/// have one.
async fn validate_manager_for_rank(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    new_rank: AgentTier,
    manager_hex: &str,
    subject: Option<&PublicKey>,
) -> Result<(), String> {
    let expected = new_rank.escalation_target();
    let manager = PublicKey::from_hex(manager_hex)
        .map_err(|_| format!("update refused: manager `{manager_hex}` is not a valid pubkey"))?;

    if Some(&manager) == subject {
        return Err("update refused: an agent cannot be its own manager".to_string());
    }

    match agent_tier(tenant, state, &manager).await? {
        None => Err(format!(
            "manager refused: {} has no resolvable place in this community; \
             a manager must be a managed agent or employee at rank `{}`",
            manager_hex,
            expected.as_str()
        )),
        Some(actual) if actual != expected => Err(format!(
            "manager refused: {} is rank `{}`, but a `{}` reports to a `{}`",
            manager_hex,
            actual.as_str(),
            new_rank.as_str(),
            expected.as_str()
        )),
        Some(_) => Ok(()),
    }
}

/// Upper bound on how many heads a single `direct_reports` scan may return.
/// A reporting line has one head per report plus, transiently, superseded
/// duplicates; two hundred covers any payroll a single manager plausibly
/// has while keeping the query bounded.
const MAX_REPORT_HEADS: i64 = 200;

/// Every agent whose authoritative head carries `manager` equal to
/// `manager`'s pubkey: the direct reports delete protection must name.
///
/// Two sources, mirroring how `agent_manager` reads the same fact back:
/// employee heads (30190, relay-signed), and managed-agent heads (30177)
/// -- where ONLY those authored by a current community owner count, because
/// that kind is client-writable and a self-published impostor head must not
/// conjure a phantom report (nor hide a real one behind a flood). An
/// employee whose row is retired is not a report any more; its rank survives
/// retirement by design (`agent_tier`'s step 1), but it can no longer hold
/// a line, so it must not block its old manager from leaving.
async fn direct_reports(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    manager: &PublicKey,
) -> Result<Vec<PublicKey>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_EMPLOYEE as i32, KIND_MANAGED_AGENT as i32]),
            tag_contains: Some(("manager".to_string(), manager.to_hex())),
            global_only: true,
            limit: Some(MAX_REPORT_HEADS),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error finding direct reports: {error}"))?;

    // Rows arrive newest-first, so keeping the FIRST head seen per `d` tag
    // implements NIP-33 latest-wins without a second sort.
    let mut newest_by_d: std::collections::HashMap<String, &buzz_core::StoredEvent> =
        std::collections::HashMap::new();
    for stored in &rows {
        let Some(d_tag) = d_tag_of(stored) else {
            continue;
        };
        newest_by_d.entry(d_tag).or_insert(stored);
    }

    let mut reports: Vec<PublicKey> = Vec::new();
    for (d_tag, stored) in newest_by_d {
        let Ok(report_bytes) = hex::decode(&d_tag) else {
            continue;
        };
        let Ok(report) = PublicKey::from_slice(&report_bytes) else {
            continue;
        };

        // The tag query also matches SUPERSEDED heads: parameterized-
        // replaceable storage keeps every version, so an old head naming
        // this manager can sit underneath a newer one that has dropped or
        // moved the line. A candidate only counts when the NEWEST head at
        // its own (kind, d) coordinate still names this manager -- the same
        // latest-wins rule every reader of these heads applies.
        if !head_still_names_manager(
            tenant,
            state,
            stored.event.kind.as_u16() as u32,
            &d_tag,
            &manager.to_hex(),
        )
        .await?
        {
            continue;
        }

        if stored.event.kind.as_u16() as u32 == KIND_MANAGED_AGENT {
            // Owner-authorship is the whole trust boundary on 30177.
            let author_is_owner = state
                .db
                .get_relay_member(tenant.community(), &stored.event.pubkey.to_hex())
                .await
                .map_err(|error| format!("database error checking report-head author: {error}"))?
                .is_some_and(|member| member.role == "owner");
            if !author_is_owner {
                continue;
            }
            reports.push(report);
        } else {
            // 30190: only an ACTIVE row holds a reporting line.
            let active = state
                .db
                .find_employee(tenant.community(), &report_bytes)
                .await
                .map_err(|error| format!("database error checking report status: {error}"))?
                .is_some_and(|employee| employee.status == "active");
            if active {
                reports.push(report);
            }
        }
    }
    reports.sort_by_key(|pubkey| pubkey.to_hex());
    Ok(reports)
}

/// Whether the NEWEST stored head of `kind` at `d_tag` still carries a
/// `manager` tag equal to `manager_hex`. One bounded query per candidate;
/// candidates are a single manager's direct reports, so this stays small.
async fn head_still_names_manager(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    kind: u32,
    d_tag: &str,
    manager_hex: &str,
) -> Result<bool, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![kind as i32]),
            d_tag: Some(d_tag.to_string()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error re-checking a report head: {error}"))?;
    Ok(rows
        .first()
        .and_then(|stored| crate::interrupt_gate::event_single_tag(&stored.event, "manager"))
        .is_some_and(|value| value == manager_hex))
}

fn d_tag_of(stored: &buzz_core::StoredEvent) -> Option<String> {
    stored.event.tags.iter().find_map(|tag| {
        if tag.kind().to_string() == "d" {
            tag.content().map(|value| value.to_string())
        } else {
            None
        }
    })
}

/// Re-derive an employee's signing keys from its sealed column.
///
/// The only way to speak as an employee. `job_broker` uses it to sign job
/// heads, which is why an employee-signed event is in practice a relay-signed
/// one: nobody else can open the seal.
pub(crate) fn open_employee_keys(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    pubkey: &[u8],
    sealed_key: &[u8],
) -> Result<Keys, String> {
    let sealer = state
        .employee_key_sealer
        .as_ref()
        .ok_or_else(|| EmployeeKeyError::NotConfigured.to_string())?;
    let employee_pubkey: [u8; 32] = pubkey
        .try_into()
        .map_err(|_| "stored employee pubkey is not 32 bytes".to_string())?;
    let secret = sealer
        .open(*tenant.community().as_uuid(), &employee_pubkey, sealed_key)
        .map_err(|error| format!("could not open the employee key: {error}"))?;
    Keys::parse(&hex::encode(secret.as_slice()))
        .map_err(|error| format!("stored employee key is unusable: {error}"))
}

/// Publish the employee head for a fresh hire, signed by the employee itself.
async fn publish_head_for_new_hire(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    keys: &Keys,
    request: &ParsedHireRequest,
    hired_by_hex: &str,
    hire_event: &Event,
) {
    let manager = request
        .manager
        .as_deref()
        .and_then(|hex| hex::decode(hex).ok());
    let hire_event_hex = hire_event.id.to_hex();
    let fields = HeadFields {
        role_id: &request.role_id,
        display_name: &request.display_name,
        rank: request.rank,
        manager: manager.as_deref(),
        hired_by_hex: Some(hired_by_hex),
        hire_event_hex: Some(&hire_event_hex),
        provisioned: None,
    };
    sign_store_and_fan_out_head(tenant, state, keys, &fields).await;
}

/// Republish the employee head from the employees ROW's state -- the
/// authoritative record. Used by the idempotent re-hire path and by kind
/// 9046 after a rank/manager change, so the head can never disagree with
/// the row longer than one fan-out.
///
/// Relay-authored events bypass ingest, so this takes on ordinary storage's
/// job: insert, then fan out. Both are best effort and logged, because the
/// durable record of employment is the row plus the owner-signed request,
/// not this head; a lost head is re-published by the next update or re-run.
async fn republish_employee_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    keys: &Keys,
    row: &buzz_db::employees::EmployeeRow,
) {
    let rank = match buzz_core::interrupt::AgentTier::parse(&row.rank) {
        Some(rank) => rank,
        None => {
            warn!(rank = %row.rank, "employee row rank does not parse; head not republished");
            return;
        }
    };
    let hired_by_hex = row.hired_by.as_deref().map(hex::encode);
    let hire_event_hex = row.hire_event.as_deref().map(hex::encode);
    let provisioned = row
        .provisioned_handle
        .as_ref()
        .zip(row.provisioned_version)
        .map(|(handle, version)| (handle.clone(), version));
    let fields = HeadFields {
        role_id: &row.role_id,
        display_name: &row.display_name,
        rank,
        manager: row.manager.as_deref(),
        hired_by_hex: hired_by_hex.as_deref(),
        hire_event_hex: hire_event_hex.as_deref(),
        provisioned: provisioned
            .as_ref()
            .map(|(handle, version)| (handle.as_str(), *version)),
    };
    sign_store_and_fan_out_head(tenant, state, keys, &fields).await;
}

/// The tag-level content of an employee head, gathered from whichever source
/// is authoritative for the path that built it.
struct HeadFields<'a> {
    role_id: &'a str,
    display_name: &'a str,
    rank: AgentTier,
    /// Raw manager pubkey bytes; `None` publishes no `manager` tag.
    manager: Option<&'a [u8]>,
    /// The owner who hired this employee. `None` on a provisioned employee,
    /// which no owner hired, and which therefore publishes no `hired-by` tag.
    hired_by_hex: Option<&'a str>,
    /// The hire request being answered. `None` for the same reason.
    hire_event_hex: Option<&'a str>,
    /// The bundled entry and version this employee was seeded from, when it
    /// was seeded at all. Published as `provisioned` and `version` tags: the
    /// field every client keys on to know this employee is provided by
    /// Colony and is not the workspace's to change.
    provisioned: Option<(&'a str, i32)>,
}

/// Sign and store an employee head (kind 30190) for `fields`, then fan it
/// out. Insert and fan-out failures are logged, not returned: callers have
/// already committed their durable state (the row), and the head heals on
/// the next re-run.
async fn sign_store_and_fan_out_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    keys: &Keys,
    fields: &HeadFields<'_>,
) {
    let mut tag_parts = vec![
        Tag::parse(["d", &keys.public_key().to_hex()]),
        Tag::parse(["role", fields.role_id]),
        Tag::parse(["name", fields.display_name]),
        Tag::parse(["rank", fields.rank.as_str()]),
    ];
    if let Some(hired_by_hex) = fields.hired_by_hex {
        tag_parts.push(Tag::parse(["hired-by", hired_by_hex]));
    }
    if let Some(hire_event_hex) = fields.hire_event_hex {
        tag_parts.push(Tag::parse(["e", hire_event_hex]));
    }
    if let Some((handle, version)) = fields.provisioned {
        tag_parts.push(Tag::parse(["provisioned", handle]));
        tag_parts.push(Tag::parse(["version", &version.to_string()]));
    }
    // The `manager` TAG is authoritative; see `agent_manager` for the read
    // side and `direct_reports` for the query side.
    if let Some(manager) = fields.manager {
        tag_parts.push(Tag::parse(["manager", &hex::encode(manager)]));
    }
    let tags = match tag_parts.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(tags) => tags,
        Err(error) => {
            warn!(error = %error, "employee head tags could not be built");
            return;
        }
    };

    let event = match EventBuilder::new(Kind::Custom(KIND_EMPLOYEE as u16), "")
        .tags(tags)
        .sign_with_keys(keys)
    {
        Ok(event) => event,
        Err(error) => {
            warn!(error = %error, "employee head could not be signed");
            return;
        }
    };

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, None)
        .await
    {
        warn!(error = %error, "employee head insert failed");
    }
    if let Err(error) = state
        .pubsub
        .publish_event(tenant, EventTopic::Global, &event)
        .await
    {
        warn!(error = %error, "employee head fan-out failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::CommunityId;

    /// An open ask row with `category` and the given event id; only the
    /// fields [`select_hiring_ask`] and its caller read are meaningful.
    fn open_hiring_ask(ask_event_id: u8) -> AskRow {
        AskRow {
            community_id: CommunityId::from_uuid(uuid::Uuid::nil()),
            ask_event_id: vec![ask_event_id; 32],
            ask_type: "decision".to_string(),
            initiative_id: "initiative-1".to_string(),
            need_key: format!("need-{ask_event_id}"),
            audience_pubkey: vec![0x01; 32],
            filer_pubkey: vec![0x02; 32],
            origin_thread: Some(vec![0x03; 32]),
            prior_ask: None,
            category: Some(HIRING_CATEGORY.to_string()),
            default_option: None,
            deadline_at: None,
            status: "open".to_string(),
            resolution_event: None,
            resolved_by: None,
            default_executed: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// An explicit `e` tag is the whole point of the exact link: it must win
    /// even where the fallback would have refused to choose.
    #[test]
    fn an_explicitly_named_ask_wins_over_an_ambiguous_fallback() {
        let explicit = open_hiring_ask(0xaa);
        let selected = select_hiring_ask(
            HireOutcome::Hired,
            Some(explicit.clone()),
            vec![open_hiring_ask(0xbb), open_hiring_ask(0xcc)],
        );
        assert_eq!(selected, Some(explicit));
    }

    /// The fallback: one open hiring ask addressed to this owner is
    /// unambiguous, so the hire closes it.
    #[test]
    fn exactly_one_open_hiring_ask_is_the_one_the_hire_answers() {
        let only = open_hiring_ask(0xaa);
        let selected = select_hiring_ask(HireOutcome::Hired, None, vec![only.clone()]);
        assert_eq!(selected, Some(only));
    }

    /// Two open hiring asks: we cannot tell which one this hire answered,
    /// and closing the wrong one is worse than the owner nudging once.
    #[test]
    fn two_open_hiring_asks_resolve_nothing() {
        let selected = select_hiring_ask(
            HireOutcome::Hired,
            None,
            vec![open_hiring_ask(0xaa), open_hiring_ask(0xbb)],
        );
        assert_eq!(selected, None);
    }

    /// Nothing was asked for, so nothing is answered.
    #[test]
    fn no_open_hiring_ask_resolves_nothing() {
        assert_eq!(
            select_hiring_ask(HireOutcome::Hired, None, Vec::new()),
            None
        );
    }

    /// A re-run of a hire request that already produced an employee must not
    /// publish a second resolution: `AlreadyHired` closes nothing, even with
    /// an exact link and an otherwise unambiguous fallback.
    #[test]
    fn a_repeat_of_an_already_completed_hire_resolves_nothing() {
        assert_eq!(
            select_hiring_ask(
                HireOutcome::AlreadyHired,
                Some(open_hiring_ask(0xaa)),
                vec![open_hiring_ask(0xbb)],
            ),
            None
        );
        assert_eq!(
            select_hiring_ask(
                HireOutcome::RoleTaken,
                Some(open_hiring_ask(0xaa)),
                vec![open_hiring_ask(0xbb)],
            ),
            None
        );
    }
}
