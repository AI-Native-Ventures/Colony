//! Colony interrupt-core: the interrupt sweep (spec: escalation timers).
//!
//! Every other piece of the interrupt system assumes an agent acts: files an
//! Ask, answers one, or replies in a thread. Agents are event-driven -- they
//! sleep between jobs -- so a leader that never wakes leaves its worker
//! blocked forever, and a founder who is asleep or offline never learns
//! anything needed them. The relay is the only always-on actor in this
//! system, so the guarantee that nothing rots has to live here, in a timer,
//! not in any agent's diligence.
//!
//! [`run_interrupt_tick`] is called on an interval by `main.rs`'s spawned
//! loop. It takes `now_secs` as an explicit parameter (rather than reading
//! the wall clock itself) precisely so tests can drive it deterministically
//! without waiting on real time.
//!
//! Per open ask whose deadline has passed ([`buzz_db::Db::query_due_asks`]):
//!
//! - **Default execution**: a decision/question ask addressed to a current
//!   owner, carrying a stated `default_option`, resolves itself with that
//!   answer. The resolution is relay-signed and flagged
//!   `"default_executed": true` so an auditor can tell it apart from a human
//!   answer at a glance. This is what turns a founder being asleep into
//!   bounded risk instead of a company-wide freeze -- see
//!   `buzz_core::interrupt::MAX_ASK_WINDOW_SECS` and the filing-time deadline
//!   clamp in `ask_broker` for the other half of that safety story (a filer
//!   cannot choose an already-past deadline to force an instant default).
//! - **Auto-promotion**: an ask addressed to a leader climbs to the unique
//!   community executive; an ask already addressed to the executive (or to
//!   an owner, with no default to fall back on) has nowhere higher to go, so
//!   it is simply re-armed with a fresh deadline instead of spinning through
//!   this sweep on every tick forever.
//!
//! ## Durable relay key
//!
//! Both branches sign a canonical, relay-authored event: a promotion bypasses
//! the altitude ladder (only the relay identity may do that -- see
//! `ask_broker::check_altitude`), and a default-execution resolution is the
//! kind of "this was answered" receipt a forged relay identity could abuse to
//! fabricate answers on a founder's behalf. Both require the SAME guard
//! `ask_broker`'s own resolution/withdrawal/filing-bypass paths already
//! enforce: without `BUZZ_RELAY_PRIVATE_KEY` configured, `state.relay_keypair`
//! is the hardcoded development key every install shares, and trusting it
//! here would let anyone who reads this repository forge default answers or
//! promotions in a production community. [`run_interrupt_tick`] refuses the
//! whole tick outright when no durable key is configured, rather than
//! attempting a partial, unsigned-equivalent sweep.
//!
//! ## Empty hops are data
//!
//! A promoted ask's original row is left in place with `status = 'promoted'`
//! (see [`buzz_db::asks`]'s module docs) rather than deleted. Its
//! `audience_pubkey` names the leader (or executive) who let the deadline
//! pass, and its `category` names what kind of decision that was. A later
//! reporting surface can therefore count "how often did this leader's asks
//! go unanswered, broken down by category" directly against the `asks`
//! table: `SELECT audience_pubkey, category, COUNT(*) FROM asks WHERE
//! status = 'promoted' GROUP BY audience_pubkey, category` -- no separate
//! metrics table is needed; the empty hop is the row itself.

use std::sync::Arc;

use buzz_core::interrupt::{parse_ask, AgentTier};
use buzz_core::kind::{KIND_ASK, KIND_ASK_RESOLUTION, KIND_MANAGED_AGENT};
use buzz_core::tenant::TenantContext;
use buzz_db::asks::AskRow;
use nostr::{EventBuilder, Kind, PublicKey, Tag};

use crate::ask_broker::{emit_ask_receipt, handle_ask_event, AskBrokerOutcome};
use crate::interrupt_gate::agent_tier;
use crate::state::AppState;

/// Outcome counters for one [`run_interrupt_tick`] pass.
///
/// Re-deadlined asks (an ask already at the top of the ladder, re-armed
/// rather than promoted or answered) are counted in neither field -- they
/// are neither a promotion nor a default execution, just the sweep declining
/// to spin on a row it cannot move forward.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct InterruptTickStats {
    /// Number of due asks that were promoted to the next altitude.
    pub promoted: u32,
    /// Number of due asks whose stated default option was executed.
    pub defaults_executed: u32,
}

/// Upper bound on managed-agent heads scanned when resolving the community's
/// unique executive (see [`find_unique_executive`]). Generous enough for any
/// real roster while still bounding the query; a flood of impostor heads at
/// many different `d` tags is a write-volume/rate-limiting concern, not
/// something this lookup can absorb on every promotion.
const MAX_ROSTER_HEADS: i64 = 500;

/// Floor on a re-armed deadline's window, in seconds. Guards against a
/// degenerate near-zero window (a due row whose `deadline_at` sits only
/// moments after its `created_at`) re-arming to a deadline that is itself
/// due again almost immediately.
const MIN_REDEADLINE_WINDOW_SECS: i64 = 60;

/// Run one interrupt-sweep pass: promote or default-execute every open ask
/// whose deadline has passed as of `now_secs`, up to `batch_limit` rows.
///
/// `now_secs` is an explicit parameter (rather than read from the wall
/// clock) so tests can drive this function deterministically; `main.rs`'s
/// spawned loop is thin wiring around this call.
///
/// Requires a durable relay signing key (`BUZZ_RELAY_PRIVATE_KEY`) -- see
/// this module's doc comment for why. Individual row failures are logged
/// and skipped so one bad row cannot block the rest of the batch; only a
/// failure that prevents the batch from being read at all (the durable-key
/// guard, or the initial `query_due_asks` call) fails the whole tick.
pub async fn run_interrupt_tick(
    state: &Arc<AppState>,
    now_secs: i64,
    batch_limit: i64,
) -> Result<InterruptTickStats, String> {
    if state.config.relay_private_key.is_none() {
        return Err(
            "interrupt sweep requires a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .to_string(),
        );
    }

    let due = state
        .db
        .query_due_asks(now_secs, batch_limit)
        .await
        .map_err(|error| format!("database error querying due asks: {error}"))?;

    let mut stats = InterruptTickStats::default();
    for row in &due {
        if let Err(error) = process_due_ask(state, row, now_secs, &mut stats).await {
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                community_id = %row.community_id,
                %error,
                "interrupt sweep: failed to process one due ask, continuing with any siblings"
            );
        }
    }
    Ok(stats)
}

/// Process one due ask row: resolve its community's host into a
/// [`TenantContext`], determine whether its audience is a current owner, and
/// dispatch to default-execution or promotion accordingly.
async fn process_due_ask(
    state: &Arc<AppState>,
    row: &AskRow,
    now_secs: i64,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
    // A background sweep has no inbound connection, so it cannot use a
    // request Host header as tenant provenance -- look the row's community
    // host back up, mirroring the reminder scheduler's cross-tenant shape
    // (`main.rs`'s `SPROUT_REMINDER_SCHEDULER` block).
    let Some(host) = state
        .db
        .lookup_community_host(row.community_id)
        .await
        .map_err(|error| format!("database error loading community host: {error}"))?
    else {
        // The community was archived or removed since this ask was filed --
        // nothing safe to sign into. Leave the row as-is; if the community
        // is ever restored, a later tick can pick it up again.
        return Ok(());
    };
    let tenant = TenantContext::resolved(row.community_id, host);

    let audience_hex = hex::encode(&row.audience_pubkey);
    let audience_is_owner = state
        .db
        .get_relay_member(tenant.community(), &audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience: {error}"))?
        .is_some_and(|member| member.role == "owner");

    if audience_is_owner {
        if let Some(default_option) = row.default_option.as_deref() {
            return execute_default(state, &tenant, row, default_option, stats).await;
        }
        // Owner-audience ask with no default: already at the very top of the
        // ladder, nowhere higher to escalate. Re-deadline rather than spin.
        return redeadline(state, &tenant, row, now_secs).await;
    }

    promote_or_redeadline(state, &tenant, row, now_secs, stats).await
}

/// Default-execute a due, owner-audience decision: sign a relay-authored
/// resolution carrying `default_option`, flip the ask row resolved, and wake
/// the filer with the same in-thread receipt a human resolution would get.
///
/// Idempotency / crash analysis (mirrors `company_broker`'s reasoning): the
/// row is claimed by [`buzz_db::Db::resolve_ask`] -- a single conditional
/// `UPDATE ... WHERE status = 'open'` -- BEFORE the resolution event is
/// stored or the wake-up receipt is emitted. A crash before the claim
/// commits leaves the row open and due; the next tick retries cleanly with
/// no side effect having happened at all. A crash after the claim commits
/// but before the event is stored or the receipt is emitted leaves the ask
/// correctly and durably resolved (`default_executed = true`, pointing at a
/// resolution event id that may not itself be stored) -- the outcome that
/// matters is already true, and only the notification is lost, exactly the
/// "loses one notification, never duplicates state" contract this sweep is
/// built to. A stale filer can always discover the resolution by querying
/// its ask's status directly rather than waiting on the wake-up message.
async fn execute_default(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    default_option: &str,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
    let Some(stored_ask) = state
        .db
        .get_event_by_id(tenant.community(), &row.ask_event_id)
        .await
        .map_err(|error| format!("database error loading ask event: {error}"))?
    else {
        return Err("ask row exists with no backing event".to_string());
    };
    let ask = parse_ask(&stored_ask.event)
        .map_err(|error| format!("stored ask event failed to parse: {error}"))?;

    let content = serde_json::json!({
        "answer": {"option": default_option},
        "default_executed": true,
    })
    .to_string();
    let resolution = EventBuilder::new(Kind::Custom(KIND_ASK_RESOLUTION as u16), content)
        .tags(vec![Tag::parse(["e", &hex::encode(&row.ask_event_id)])
            .map_err(|error| {
                format!("failed to build resolution `e` tag: {error}")
            })?])
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign default-execution resolution: {error}"))?;

    // Claim before side effect.
    let flipped = state
        .db
        .resolve_ask(
            tenant.community(),
            &row.ask_event_id,
            resolution.id.as_bytes(),
            state.relay_keypair.public_key().as_bytes(),
            true,
        )
        .await
        .map_err(|error| format!("database error resolving ask with default: {error}"))?;
    if !flipped {
        // Lost a race against a human resolution/withdrawal that closed this
        // exact ask a moment earlier -- nothing left to execute.
        return Ok(());
    }

    // Store the signed resolution itself so it is queryable like any other
    // ask-protocol event (`ask_broker`'s own resolutions fall through to
    // ordinary storage after the broker's checks pass; this sweep writes
    // directly, so it takes on that responsibility itself). Best-effort: the
    // ask is already durably resolved above, so a storage failure here does
    // not roll that back.
    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &resolution, None)
        .await
    {
        tracing::warn!(
            %error,
            "interrupt sweep: failed to store the default-execution resolution event"
        );
    }

    if let Some(origin_thread) = &row.origin_thread {
        let filer = PublicKey::from_slice(&row.filer_pubkey)
            .map_err(|error| format!("stored filer pubkey is invalid: {error}"))?;
        emit_ask_receipt(
            tenant,
            state,
            &hex::encode(origin_thread),
            &format!("Default executed: {} -> {default_option}", ask.headline),
            filer,
            stored_ask.channel_id,
        )
        .await;
    }

    stats.defaults_executed += 1;
    Ok(())
}

/// Resolve where a due, non-owner-audience ask should go next and act on it:
/// promote a leader-audience ask to the community's unique executive, or
/// re-deadline an ask that is already addressed to the executive (nowhere
/// higher to go). Never guesses a target it cannot confidently resolve --
/// design point 3: silently choosing an executive nobody appointed would
/// route a founder's decisions through the wrong agent.
async fn promote_or_redeadline(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    now_secs: i64,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
    let audience_pubkey = PublicKey::from_slice(&row.audience_pubkey)
        .map_err(|error| format!("stored audience pubkey is invalid: {error}"))?;
    let audience_tier = agent_tier(tenant, state, &audience_pubkey).await?;

    match audience_tier {
        Some(AgentTier::Leader) => {
            let Some(executive) = find_unique_executive(tenant, state).await? else {
                tracing::warn!(
                    ask_event_id = %hex::encode(&row.ask_event_id),
                    community_id = %tenant.community(),
                    "interrupt sweep: cannot promote, community has zero or multiple \
                     executives; never guessing which one to route to"
                );
                return Ok(());
            };
            promote_to(state, tenant, row, executive, stats).await
        }
        Some(AgentTier::Executive) => redeadline(state, tenant, row, now_secs).await,
        Some(AgentTier::Worker) | None => {
            // A worker is never a legitimate ask audience (workers only
            // raise asks, never receive them), and `None` here means the
            // audience is neither a recognized agent tier nor -- checked by
            // the caller before this function runs -- a current owner. Both
            // mean the tier data underneath this open ask changed since it
            // was filed (e.g. the agent was demoted or its managed-agent
            // head was replaced). Never guess a promotion target for a state
            // that should not exist; leave the row for a human to notice.
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                community_id = %tenant.community(),
                "interrupt sweep: due ask's audience no longer resolves to a leader, \
                 executive, or owner; leaving it untouched rather than guessing"
            );
            Ok(())
        }
    }
}

/// Promote a due, leader-audience ask to `target` (the community's unique
/// executive): build a relay-signed copy of the original ask, addressed to
/// `target` and carrying a `prior` tag back to the original, mark the
/// original `promoted`, then create and dispatch the new ask.
///
/// Idempotency / crash analysis: the original and its promotion share the
/// exact same `(initiative_id, need_key)` dedupe slot (`buzz_db::asks`'s
/// module docs), so the promotion cannot be inserted while the original
/// still holds that slot open -- [`buzz_db::Db::mark_ask_promoted`] (the
/// claim) MUST run before [`crate::ask_broker::handle_ask_event`] (the side
/// effect that actually creates the new open row) can succeed. A crash
/// before the claim commits leaves the original open and due, no side
/// effect has happened, and the next tick retries cleanly. A crash after
/// the claim commits but before the new ask is created leaves the original
/// row reading `promoted` toward an event id that was never actually
/// created -- unlike the default-execution path, this is not merely a lost
/// notification: the need has no open ask at any tier until something else
/// notices. This is the one crash window this sweep does not close on its
/// own; a future stall-detection sweep (over initiatives with no open ask
/// and no recent activity) is the natural place to add coverage for it.
/// Once claimed, the new ask event is stored and dispatched last and
/// best-effort, mirroring `execute_default`: the projection row from
/// `handle_ask_event` is what actually matters, not the fan-out.
async fn promote_to(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    target: PublicKey,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
    let Some(stored_ask) = state
        .db
        .get_event_by_id(tenant.community(), &row.ask_event_id)
        .await
        .map_err(|error| format!("database error loading ask event to promote: {error}"))?
    else {
        return Err("ask row exists with no backing event to promote".to_string());
    };

    let mut tags: Vec<Tag> = stored_ask
        .event
        .tags
        .iter()
        .filter(|tag| {
            !matches!(
                tag.as_slice().first().map(String::as_str),
                Some("p") | Some("prior") | Some("filer")
            )
        })
        .cloned()
        .collect();
    tags.push(Tag::public_key(target));
    tags.push(
        Tag::parse(["prior", &stored_ask.event.id.to_hex()])
            .map_err(|error| format!("failed to build `prior` tag: {error}"))?,
    );
    // Carry the ORIGINAL filer forward (C1 fix): this event is relay-signed,
    // so `ask_broker::handle_ask`'s `filer_pubkey` would otherwise record
    // the relay itself as the blocked agent, and every downstream wake-up
    // receipt (Task 6's auto-resolve, `handle_resolution`,
    // `handle_withdrawal`) would p-tag the relay instead of the worker
    // actually waiting. `row.filer_pubkey` is already correct across
    // arbitrarily many hops -- it was itself resolved by this same
    // preference the last time this need was filed or promoted.
    let filer_pubkey = PublicKey::from_slice(&row.filer_pubkey)
        .map_err(|error| format!("stored filer pubkey is invalid: {error}"))?;
    tags.push(
        Tag::parse(["filer", &filer_pubkey.to_hex()])
            .map_err(|error| format!("failed to build `filer` tag: {error}"))?,
    );

    let promoted_event =
        EventBuilder::new(Kind::Custom(KIND_ASK as u16), &stored_ask.event.content)
            .tags(tags)
            .sign_with_keys(&state.relay_keypair)
            .map_err(|error| format!("failed to sign promoted ask: {error}"))?;

    // Claim before side effect: see this function's doc comment for the
    // crash window this ordering accepts and why the ordering cannot be
    // reversed.
    let claimed = state
        .db
        .mark_ask_promoted(
            tenant.community(),
            &row.ask_event_id,
            promoted_event.id.as_bytes(),
        )
        .await
        .map_err(|error| format!("database error marking ask promoted: {error}"))?;
    if !claimed {
        // Lost a race against a resolution/withdrawal that closed this exact
        // ask a moment earlier -- the promotion built above is simply
        // discarded, never stored or dispatched. No side effect happened,
        // so there is nothing to undo.
        return Ok(());
    }

    match handle_ask_event(tenant, state, &promoted_event).await? {
        AskBrokerOutcome::Applied => {}
        AskBrokerOutcome::Duplicate { .. } => {
            // Vanishingly narrow: something else claimed this exact need in
            // the instant between the claim above and this call. The need
            // still has a live open ask -- the racing one -- so it is not
            // orphaned, just not this promotion. Nothing more to do.
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                "interrupt sweep: promoted ask lost a filing race for its need; \
                 the need still has a live open ask, just not this one"
            );
            return Ok(());
        }
        AskBrokerOutcome::Refused { message } => {
            return Err(format!(
                "internal error: relay-signed promotion was refused: {message}"
            ));
        }
    }

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &promoted_event, stored_ask.channel_id)
        .await
    {
        tracing::warn!(%error, "interrupt sweep: failed to store the promoted ask event");
    } else if let Err(error) = state
        .pubsub
        .publish_event(
            tenant,
            stored_ask
                .channel_id
                .map(buzz_pubsub::EventTopic::Channel)
                .unwrap_or(buzz_pubsub::EventTopic::Global),
            &promoted_event,
        )
        .await
    {
        tracing::warn!(%error, "interrupt sweep: failed to fan out the promoted ask event");
    }

    stats.promoted += 1;
    Ok(())
}

/// Re-arm a due ask's deadline to `now_secs` plus its own original window,
/// without promoting or resolving it (design point 4: an ask already at the
/// top of the ladder must not spin through this sweep on every tick).
///
/// Reuses the ask's own original window (`deadline_at - created_at` on the
/// row, floored at [`MIN_REDEADLINE_WINDOW_SECS`]) rather than a hardcoded
/// constant, so an ask filed with an explicit `default_window_secs` keeps
/// that cadence across re-arms instead of silently falling back to a
/// platform default.
async fn redeadline(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    now_secs: i64,
) -> Result<(), String> {
    let original_deadline = row
        .deadline_at
        .ok_or_else(|| "internal error: a due ask row has no deadline".to_string())?;
    let window_secs = (original_deadline - row.created_at).max(MIN_REDEADLINE_WINDOW_SECS);
    let new_deadline = now_secs.saturating_add(window_secs);

    // Claim-and-done in one step: there is no separate side effect to crash
    // between here, so there is nothing more to say about ordering than for
    // `resolve_ask`/`mark_ask_promoted` -- either the conditional UPDATE
    // commits or it does not.
    state
        .db
        .extend_ask_deadline(tenant.community(), &row.ask_event_id, new_deadline)
        .await
        .map_err(|error| format!("database error extending ask deadline: {error}"))?;
    Ok(())
}

/// Resolve the community's unique executive: the one agent pubkey (`d` tag)
/// whose latest owner-authored managed-agent head (kind [`KIND_MANAGED_AGENT`])
/// declares `tier: "executive"`.
///
/// `Ok(None)` when zero or more than one distinct pubkey qualifies -- design
/// point 3 (never guess). Mirrors `interrupt_gate::agent_tier`'s
/// per-candidate owner-authorship scan, generalized across every `d` tag in
/// one pass: rows arrive newest-first (`created_at DESC`), and the first
/// owner-authored head found for a given `d` tag is authoritative for that
/// agent -- older heads at the same `d` tag are ignored once settled,
/// exactly like a single-pubkey lookup would ignore them.
async fn find_unique_executive(
    tenant: &TenantContext,
    state: &AppState,
) -> Result<Option<PublicKey>, String> {
    let rows = state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_MANAGED_AGENT as i32]),
            global_only: true,
            limit: Some(MAX_ROSTER_HEADS),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
        .map_err(|error| format!("database error scanning managed-agent roster: {error}"))?;

    let mut settled: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut executives: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    for stored in rows {
        let Some(d_tag) = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
        }) else {
            continue;
        };
        if settled.contains(&d_tag) {
            // Already resolved (or deliberately given up on) this agent from
            // a newer head.
            continue;
        }

        let author_hex = stored.event.pubkey.to_hex();
        let author_is_owner = state
            .db
            .get_relay_member(tenant.community(), &author_hex)
            .await
            .map_err(|error| format!("database error checking managed-agent head author: {error}"))?
            .is_some_and(|member| member.role == "owner");
        if !author_is_owner {
            // Keep scanning older heads for this same `d` tag.
            continue;
        }
        // This IS the authoritative head for this agent (NIP-33 latest-wins
        // among the owner's own heads) -- settle it here even if its
        // content turns out to be malformed, rather than falling through to
        // an older head the owner has already superseded.
        settled.insert(d_tag.clone());

        let Ok(content) = serde_json::from_str::<serde_json::Value>(&stored.event.content) else {
            continue;
        };
        let tier = content
            .get("tier")
            .and_then(|value| value.as_str())
            .and_then(AgentTier::parse);
        if tier != Some(AgentTier::Executive) {
            continue;
        }
        let Ok(pubkey_bytes) = hex::decode(&d_tag) else {
            continue;
        };
        if let Ok(pubkey) = PublicKey::from_slice(&pubkey_bytes) {
            executives.insert(*pubkey.as_bytes());
        }
    }

    if executives.len() == 1 {
        let bytes = executives
            .into_iter()
            .next()
            .expect("checked executives.len() == 1 above");
        PublicKey::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("resolved executive pubkey is invalid: {error}"))
    } else {
        Ok(None)
    }
}
