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
//!   community executive, and an ask addressed to that executive climbs one
//!   further, to the community's unique human owner -- the last hop, and the
//!   only relay-driven path that ever reaches a person. Without it an
//!   executive that is dead, hung, or simply not running would silently
//!   accumulate asks against it forever while the founder learned nothing.
//!   An ask already addressed to an owner (with no default to fall back on),
//!   or whose next rung cannot be resolved unambiguously, has nowhere to go,
//!   so it is simply re-armed with a fresh deadline instead of spinning
//!   through this sweep on every tick forever.
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
//!
//! ## Stall detection (spec: dead agents)
//!
//! Everything above assumes an ask exists: some agent noticed it was blocked
//! and raised one. [`run_stall_tick`] covers the other failure mode -- an
//! agent that crashes, hangs, or is simply killed mid-task raises nothing at
//! all. The task it was working just stops moving, silently, and nothing is
//! blocked on a human, so no ask exists for the sweep above to promote or
//! default-execute. [`run_stall_tick`] finds a task that should be moving
//! (its head content `status` is `inProgress`) and has shown no real event
//! activity for at least `stall_after_secs`, and files exactly one
//! relay-signed `stall` ask about it, addressed to whoever is accountable.
//!
//! It also closes a residual from [`promote_to`]'s crash window: a
//! `promoted` ask whose successor was never actually created (a true process
//! crash between the claim committing and the successor being filed) has no
//! open ask at any tier and would otherwise wait forever. No in-process
//! compensation survives that crash; this sweep is the out-of-process
//! backstop that finds and reopens it.

use std::sync::Arc;

use buzz_core::company::CompanyTask;
use buzz_core::interrupt::{parse_ask, AgentTier, AskType};
use buzz_core::kind::{KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_MANAGED_AGENT};
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::asks::AskRow;
use nostr::{EventBuilder, Kind, PublicKey, Tag};
use sha2::{Digest, Sha256};

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

/// Upper bound on distinct AGENTS (`d` tags) returned by
/// [`fetch_owner_authored_managed_agent_roster`] when resolving the
/// community's unique executive (see [`find_unique_executive`]). The bound
/// is pushed into SQL (`Db::query_latest_owner_authored_heads`'s `DISTINCT
/// ON (d_tag)`), so it caps agents, not head revisions: a community whose
/// agents' heads are republished often can no longer push another agent's
/// single head out of the window just by revision volume. Generous enough
/// for any real roster while still bounding the query; a flood of impostor
/// heads at many different `d` tags is a write-volume/rate-limiting
/// concern, not something this lookup can absorb on every promotion.
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
        // nothing safe to sign into. Re-deadline (C2 fix) rather than leave
        // the row permanently stuck at the head of the cross-tenant due
        // batch: if the community is ever restored, a later tick can pick
        // it up again once its deadline next arrives.
        tracing::warn!(
            ask_event_id = %hex::encode(&row.ask_event_id),
            community_id = %row.community_id,
            "interrupt sweep: ask's community has no resolvable host (archived or removed); \
             re-deadlining rather than leaving it stuck"
        );
        return redeadline(state, row.community_id, row, now_secs).await;
    };
    let tenant = TenantContext::resolved(row.community_id, host);

    // Load the backing ask event ONCE, here, before any branch decides what
    // to do with the row (I2, completed). The two guards this replaces sat
    // inside `execute_default` and `promote_to`, which meant a ghost row was
    // only ever detected on the paths that happen to need the event: an
    // owner-audience ask with no `default_option` returned at the
    // top-of-ladder branch below, and `promote_or_redeadline` declined
    // before reaching `promote_to` whenever the next rung could not be
    // resolved, so both re-deadlined a wedged need forever. An executive
    // filing to the owner with no stated default is the ORDINARY
    // top-of-ladder ask, so that was the filing whose loss mattered most.
    // Hoisting the lookup covers every shape structurally, rather than
    // covering two shapes and leaving the rest to be discovered later.
    let Some(stored_ask) = state
        .db
        .get_event_by_id(tenant.community(), &row.ask_event_id)
        .await
        .map_err(|error| format!("database error loading ask event: {error}"))?
    else {
        if let Err(close_error) = close_ask_with_no_backing_event(state, &tenant, row).await {
            tracing::warn!(
                %close_error,
                "interrupt sweep: failed to close an ask with no backing event"
            );
        }
        return Err("ask row exists with no backing event".to_string());
    };

    let audience_hex = hex::encode(&row.audience_pubkey);
    let audience_is_owner = state
        .db
        .get_relay_member(tenant.community(), &audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience: {error}"))?
        .is_some_and(|member| member.role == "owner");

    if audience_is_owner {
        if let Some(default_option) = row.default_option.as_deref() {
            return execute_default(state, &tenant, row, &stored_ask, default_option, stats).await;
        }
        // Owner-audience ask with no default: already at the very top of the
        // ladder, nowhere higher to escalate. Re-deadline rather than spin.
        return redeadline(state, tenant.community(), row, now_secs).await;
    }

    promote_or_redeadline(state, &tenant, row, &stored_ask, now_secs, stats).await
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
    stored_ask: &buzz_core::StoredEvent,
    default_option: &str,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
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
/// promote a leader-audience ask to the community's unique executive, promote
/// an executive-audience ask to the community's unique OWNER, or re-deadline
/// an ask whose next target cannot be confidently resolved at all.
/// Never guesses a target -- design point 3: silently choosing an executive
/// nobody appointed would route a founder's decisions through the wrong
/// agent, and silently choosing one of several co-owners would put a decision
/// in front of the wrong human -- but every branch still re-deadlines rather
/// than leaving the row untouched (C2 fix): a due ask this function declines
/// to act on must not permanently occupy a slot in the cross-tenant due batch
/// and starve every other community's due asks behind it.
///
/// The executive arm is the last hop, and the reason this whole module
/// exists (I1, whole-branch review). Before it, every relay-driven path
/// terminated at an agent: an executive-audience ask was re-deadlined
/// forever, default execution required an owner audience, and stall asks are
/// addressed to agents. An executive that is dead, hung, or simply not
/// running therefore accumulated asks against it silently, and the founder
/// learned nothing -- the precise failure this module's own doc comment says
/// the timers exist to prevent. Once promoted to an owner, the ask is at the
/// genuine top of the ladder: the next deadline either default-executes it
/// (if it carries a stated default) or re-deadlines it, which is the
/// pre-existing owner-audience behaviour.
async fn promote_or_redeadline(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    stored_ask: &buzz_core::StoredEvent,
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
                     executives; never guessing which one to route to -- re-deadlining \
                     so this row does not starve the rest of the batch"
                );
                return redeadline(state, tenant.community(), row, now_secs).await;
            };
            promote_to(state, tenant, row, stored_ask, executive, stats).await
        }
        Some(AgentTier::Executive) => {
            let Some(owner) = find_unique_owner(tenant, state).await? else {
                tracing::warn!(
                    ask_event_id = %hex::encode(&row.ask_event_id),
                    community_id = %tenant.community(),
                    "interrupt sweep: cannot file to a human, community has zero or multiple \
                     owners; never guessing which one to route to -- re-deadlining so this row \
                     does not starve the rest of the batch"
                );
                return redeadline(state, tenant.community(), row, now_secs).await;
            };
            promote_to(state, tenant, row, stored_ask, owner, stats).await
        }
        Some(AgentTier::Worker) | None => {
            // A worker is never a legitimate ask audience (workers only
            // raise asks, never receive them), and `None` here means the
            // audience is neither a recognized agent tier nor -- checked by
            // the caller before this function runs -- a current owner. Both
            // mean the tier data underneath this open ask changed since it
            // was filed (e.g. the agent was demoted or its managed-agent
            // head was replaced). Never guess a promotion target for a state
            // that should not exist; leave the row for a human to notice --
            // but still re-deadline it (C2 fix) so it does not starve the
            // rest of the batch while waiting to be noticed.
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                community_id = %tenant.community(),
                "interrupt sweep: due ask's audience no longer resolves to a leader, \
                 executive, or owner; re-deadlining rather than guessing a target"
            );
            redeadline(state, tenant.community(), row, now_secs).await
        }
    }
}

/// Promote a due ask to `target`, the next rung up the ladder (the
/// community's unique executive for a leader-audience ask, its unique owner
/// for an executive-audience one): build a relay-signed copy of the original
/// ask, addressed to `target` and carrying a `prior` tag back to the
/// original, mark the original `promoted`, then create and dispatch the new
/// ask.
///
/// Idempotency / crash analysis: the original and its promotion share the
/// exact same `(initiative_id, need_key)` dedupe slot (`buzz_db::asks`'s
/// module docs), so the promotion cannot be inserted while the original
/// still holds that slot open -- [`buzz_db::Db::mark_ask_promoted`] (the
/// claim) MUST run before [`crate::ask_broker::handle_ask_event`] (the side
/// effect that actually creates the new open row) can succeed. A crash
/// before the claim commits leaves the original open and due, no side
/// effect has happened, and the next tick retries cleanly.
///
/// A crash exactly between the claim committing and the new ask being
/// created leaves the original row reading `promoted` toward an event id
/// that was never actually created -- unlike the default-execution path,
/// this is not merely a lost notification: the need has no open ask at any
/// tier until something else notices. This IS the one window this sweep
/// cannot close on its own: no in-process compensation survives a genuine
/// process crash at that exact instant. A future stall-detection sweep
/// (over initiatives with no open ask and no recent activity) is the
/// natural place to add coverage for it.
///
/// An ORDINARY failure in that same window -- `handle_ask_event` returning
/// `Err` (a database error) or `AskBrokerOutcome::Refused` -- is different
/// from a crash: the process is still running, so [`reopen_after_promotion_failure`]
/// compensates by reverting the claim (predicated on the row still being
/// promoted toward exactly this attempt's event id, so it cannot resurrect
/// a row closed some other way), giving the original ask another chance on
/// the next tick instead of leaving it permanently orphaned. A single bad
/// second on the database connection is a real, reachable failure mode
/// (unlike a hard crash), so deferring it the same way as the crash-only
/// residual above would not have been defensible.
///
/// Once claimed, the new ask event is stored and dispatched last and
/// best-effort, mirroring `execute_default`: the projection row from
/// `handle_ask_event` is what actually matters, not the fan-out.
async fn promote_to(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    stored_ask: &buzz_core::StoredEvent,
    target: PublicKey,
    stats: &mut InterruptTickStats,
) -> Result<(), String> {
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

    // C3 fix: an ordinary Err or a Refused here both mean the claim above
    // already committed but the successor never became a real open ask --
    // the need would otherwise be permanently orphaned (no open ask at any
    // tier, and `query_due_asks` never returns a `promoted` row again).
    // Compensate by reopening the original in both arms; see this
    // function's doc comment for exactly what residual risk this narrows
    // down to.
    let outcome = match handle_ask_event(tenant, state, &promoted_event).await {
        Ok(outcome) => outcome,
        Err(error) => {
            reopen_after_promotion_failure(state, tenant, row, promoted_event.id.as_bytes()).await;
            return Err(error);
        }
    };
    match outcome {
        AskBrokerOutcome::Applied => {}
        AskBrokerOutcome::Duplicate { .. } => {
            // Vanishingly narrow: something else claimed this exact need in
            // the instant between the claim above and this call. The need
            // still has a live open ask -- the racing one -- so it is not
            // orphaned, just not this promotion. Nothing more to do (and
            // nothing to reopen: the original correctly stays `promoted`,
            // superseded by whatever won the race).
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                "interrupt sweep: promoted ask lost a filing race for its need; \
                 the need still has a live open ask, just not this one"
            );
            return Ok(());
        }
        AskBrokerOutcome::Refused { message } => {
            reopen_after_promotion_failure(state, tenant, row, promoted_event.id.as_bytes()).await;
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

/// Compensate for a promotion whose successor failed after
/// [`buzz_db::Db::mark_ask_promoted`] already committed (C3 fix, `promote_to`):
/// revert the original back to `open` via [`buzz_db::Db::reopen_promoted_ask`],
/// predicated on it still being promoted toward exactly `promoted_event_id`
/// so a concurrent close by something else is never clobbered.
///
/// Best-effort and swallows its own failure: the caller has already decided
/// to return an error for the promotion attempt itself, and a failure here
/// (the compensating `UPDATE` erroring, or simply finding the row no longer
/// matches) must not mask that error, only narrow how much can be said
/// about what state the row is left in.
async fn reopen_after_promotion_failure(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
    promoted_event_id: &[u8],
) {
    match state
        .db
        .reopen_promoted_ask(tenant.community(), &row.ask_event_id, promoted_event_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            // Already reverted by a concurrent attempt, or closed some
            // other way in the meantime -- not this call's problem either
            // way.
        }
        Err(error) => {
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                %error,
                "interrupt sweep: failed to reopen a promoted ask after its successor failed; \
                 it will stay stuck `promoted` until noticed some other way"
            );
        }
    }
}

/// Close an `asks` row whose backing Ask event was never stored (I2), with a
/// relay-signed synthetic withdrawal naming the cause.
///
/// The broker commits the `asks` row at ingest immediately BEFORE ordinary
/// storage, and storage can still fail after it. The resulting state is an
/// `open` row pointing at an event that does not exist, and every in-protocol
/// remedy is closed off by that same absence: a retry of the need returns
/// `Duplicate` naming a ghost, and both `handle_resolution` and
/// `handle_withdrawal` refuse with "the referenced ask does not exist"
/// because they load the referenced event first. Re-deadlining the row (the
/// original C2 fix here) correctly stopped it starving the cross-tenant
/// batch, but left the need permanently unfileable, clearable only by a DBA.
///
/// Closing it converts that permanent wedge into a self-healing one: the
/// dedupe slot is released within one sweep window and the blocked agent can
/// simply file again. The row is closed as `withdrawn` rather than under a
/// new status because "this need is no longer waiting on anyone" is exactly
/// what `withdrawn` already means, and a new status value would need a
/// migration to widen the `asks.status` CHECK constraint.
///
/// The withdrawal event is signed and STORED rather than the status being
/// flipped silently, for two reasons: an operator following the row's
/// `resolution_event` finds a readable reason instead of a dangling id, and
/// `buzz asks list --status open` computes open/closed from the public event
/// stream (the `asks` table has no HTTP read surface), so without the event
/// the ghost ask would keep showing as open to every client. Only the
/// interrupt sweep calls this, and [`run_interrupt_tick`] has already
/// refused the whole tick without a durable relay key, so the signature here
/// is never the shared fallback dev key.
///
/// Claim before side effect, matching [`execute_default`]: the conditional
/// `withdraw_ask` runs before the event is stored. A crash between them
/// leaves the row correctly closed pointing at an unstored withdrawal, which
/// is strictly better than the wedge it replaces. No wake-up receipt is
/// posted: there is nothing to tell the filer beyond "file again", and the
/// origin thread is on the very event that is missing.
async fn close_ask_with_no_backing_event(
    state: &Arc<AppState>,
    tenant: &TenantContext,
    row: &AskRow,
) -> Result<(), String> {
    // Describes what was OBSERVED, not a cause inferred from it:
    // `get_event_by_id` filters out soft-deleted events, so an ask that was
    // legitimately stored and later deleted is indistinguishable here from
    // one that never landed. Both wedge the need identically (resolution and
    // withdrawal load the referenced event through the same filtered read),
    // so both deserve this closure -- but the reason an operator reads must
    // not assert the one it cannot tell apart from the other.
    let reason = format!(
        "closed by the relay: this ask's own event (id {}) could not be loaded -- it was never \
         stored, or has been deleted since -- so the ask could not be answered, withdrawn, or \
         re-filed. Releasing the need so it can be raised again.",
        hex::encode(&row.ask_event_id)
    );
    let content = serde_json::json!({ "reason": reason }).to_string();
    let withdrawal = EventBuilder::new(Kind::Custom(KIND_ASK_WITHDRAWAL as u16), content)
        .tags(vec![Tag::parse(["e", &hex::encode(&row.ask_event_id)])
            .map_err(|error| {
                format!("failed to build withdrawal `e` tag: {error}")
            })?])
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign synthetic withdrawal: {error}"))?;

    // Claim before side effect.
    let withdrawn = state
        .db
        .withdraw_ask(
            tenant.community(),
            &row.ask_event_id,
            withdrawal.id.as_bytes(),
        )
        .await
        .map_err(|error| format!("database error closing an ask with no backing event: {error}"))?;
    if !withdrawn {
        // Something else closed this exact row a moment earlier -- nothing
        // left to release, and the signed withdrawal is simply discarded.
        return Ok(());
    }

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &withdrawal, None)
        .await
    {
        tracing::warn!(
            %error,
            "interrupt sweep: failed to store the synthetic withdrawal for an ask with no \
             backing event"
        );
    } else if let Err(error) = state
        .pubsub
        .publish_event(tenant, buzz_pubsub::EventTopic::Global, &withdrawal)
        .await
    {
        tracing::warn!(
            %error,
            "interrupt sweep: failed to fan out the synthetic withdrawal for an ask with no \
             backing event"
        );
    }

    tracing::warn!(
        ask_event_id = %hex::encode(&row.ask_event_id),
        community_id = %tenant.community(),
        "interrupt sweep: closed an ask row whose backing event was never stored, releasing \
         its need for re-filing"
    );
    Ok(())
}

/// Re-arm a due ask's deadline to `now_secs` plus its own original window,
/// without promoting or resolving it. Backs two distinct situations:
///
/// - design point 4: an ask already at the top of the ladder (owner or
///   executive audience, no default to fall back on) must not spin through
///   this sweep on every tick;
/// - C2 fix (Task 8 fix round): EVERY branch that declines to act on a due
///   ask -- an unresolvable promotion target, an archived community, a data
///   invariant violation -- must also yield its place, or it permanently
///   occupies a slot in [`buzz_db::Db::query_due_asks`]'s cross-tenant,
///   deadline-ordered, batch-capped result. Left untouched, enough such
///   rows accumulate at the head of that ordering to starve every other due
///   ask in every other community: the batch fills with the same declined
///   rows on every tick and nothing beyond them is ever reached, silently.
///   Declining to promote or resolve a row is a legitimate outcome; leaving
///   its deadline untouched afterward is not.
///
/// Takes a bare [`CommunityId`] rather than `&TenantContext` because the
/// community-not-found decline branch (`process_due_ask`) has no resolved
/// tenant to offer -- `extend_ask_deadline` only ever needed the community
/// id, never the host.
///
/// Reuses the ask's own original window (`deadline_at - created_at` on the
/// row, floored at [`MIN_REDEADLINE_WINDOW_SECS`]) rather than a hardcoded
/// constant, so an ask filed with an explicit `default_window_secs` keeps
/// that cadence across re-arms instead of silently falling back to a
/// platform default.
async fn redeadline(
    state: &Arc<AppState>,
    community: CommunityId,
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
        .extend_ask_deadline(community, &row.ask_event_id, new_deadline)
        .await
        .map_err(|error| format!("database error extending ask deadline: {error}"))?;
    Ok(())
}

/// A managed-agent roster resolved once via
/// [`fetch_owner_authored_managed_agent_roster`]: `(d_tag, content)` pairs,
/// one per distinct pubkey that has a CURRENT-owner-authored head. Reused
/// for both an executive lookup ([`unique_executive_in_roster`]) and any
/// number of persona lookups ([`persona_pubkey_in_roster`]) without a
/// second database round trip -- see [`run_stall_tick`]'s per-community
/// memoisation (I5).
type ManagedAgentRoster = Vec<(String, serde_json::Value)>;

/// Fetch every managed-agent head (kind [`KIND_MANAGED_AGENT`]) in `tenant`,
/// resolved to NIP-33 latest-wins PER PUBKEY (`d` tag) among heads authored
/// by a CURRENT community owner.
///
/// This is the trust rule `interrupt_gate::agent_tier` established for a
/// single, already-known pubkey (Task 4's fix: `KIND_MANAGED_AGENT` carries
/// only `Scope::UsersWrite` at ingest, so ANY authenticated member --
/// including the very agent a head describes -- can publish one; without
/// restricting to owner-authored heads, an impostor could self-declare a
/// tier, or shadow a legitimate head and make the lookup fall back to
/// nothing, which is just as damaging as a false claim). Generalized here
/// across every pubkey in one bounded scan rather than one lookup per
/// candidate pubkey, for callers that do not already know which pubkey they
/// are looking for -- [`unique_executive_in_roster`] (which pubkey is the
/// executive?) and [`persona_pubkey_in_roster`] (which pubkey runs this
/// persona?). `agent_tier` itself is untouched: it is scoped to one pubkey
/// via a `d_tag`-filtered query, which is a genuinely different (and more
/// efficient, for that narrower question) shape than this all-pubkeys scan,
/// so sharing code with it directly would not be a clean factor.
///
/// A NON-owner-authored head at a pubkey is never trusted, however new --
/// this is now enforced in SQL (`Db::query_latest_owner_authored_heads`'s
/// owner `JOIN`), not by scanning newest-first and skipping non-owner rows:
/// a non-owner's head at a `d` tag is excluded from the candidate set before
/// `DISTINCT ON` ever picks a newest row, so it can never shadow (or stand
/// in for) the owner's authoritative head. A pubkey with no owner-authored
/// head at all simply has no entry in the returned roster.
async fn fetch_owner_authored_managed_agent_roster(
    tenant: &TenantContext,
    state: &AppState,
    limit: i64,
) -> Result<ManagedAgentRoster, String> {
    let rows = state
        .db
        .query_latest_owner_authored_heads(tenant.community(), KIND_MANAGED_AGENT as i32, limit)
        .await
        .map_err(|error| format!("database error scanning managed-agent roster: {error}"))?;

    let mut roster = ManagedAgentRoster::new();
    for stored in rows {
        let Some(d_tag) = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 2 && parts[0] == "d").then(|| parts[1].clone())
        }) else {
            continue;
        };
        // NIP-33 latest-wins among the owner's own heads: the query already
        // returned exactly one newest owner-authored head per `d` tag, so a
        // malformed content settles its agent (skipped, no fallback to an
        // older superseded head) -- the same semantics the Rust-side scan
        // this replaced enforced row by row.
        let Ok(content) = serde_json::from_str::<serde_json::Value>(&stored.event.content) else {
            continue;
        };
        roster.push((d_tag, content));
    }

    Ok(roster)
}

/// Resolve the community's unique executive from an already-fetched
/// [`ManagedAgentRoster`]: the one agent pubkey (`d` tag) whose head
/// declares `tier: "executive"`.
///
/// `Ok(None)` when zero or more than one distinct pubkey qualifies -- design
/// point 3 (never guess). Pure (no I/O) so a caller looping over many
/// candidates in the same community can call it repeatedly against ONE
/// fetched roster instead of re-querying.
fn unique_executive_in_roster(roster: &ManagedAgentRoster) -> Result<Option<PublicKey>, String> {
    let mut executives: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    for (d_tag, content) in roster {
        let tier = content
            .get("tier")
            .and_then(|value| value.as_str())
            .and_then(AgentTier::parse);
        if tier != Some(AgentTier::Executive) {
            continue;
        }
        let Ok(pubkey_bytes) = hex::decode(d_tag) else {
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

/// Resolve the community's unique executive. Fetches a fresh
/// [`ManagedAgentRoster`] every call -- used by [`promote_or_redeadline`],
/// which processes one due ask at a time and has no batch to amortise a
/// fetch across. [`run_stall_tick`] instead fetches the roster once per
/// community and calls [`unique_executive_in_roster`] directly against the
/// memoised copy (I5) -- both paths share the exact same trust rule via
/// [`fetch_owner_authored_managed_agent_roster`].
async fn find_unique_executive(
    tenant: &TenantContext,
    state: &AppState,
) -> Result<Option<PublicKey>, String> {
    let roster = fetch_owner_authored_managed_agent_roster(tenant, state, MAX_ROSTER_HEADS).await?;
    unique_executive_in_roster(&roster)
}

/// Resolve the community's unique human owner: the single pubkey currently
/// holding the `owner` relay-membership role (I1's last hop).
///
/// `Ok(None)` when zero or more than one qualifies -- the same never-guess
/// discipline [`unique_executive_in_roster`] applies one rung lower. Two
/// co-owners is not an error state; it just means the relay cannot say which
/// human a decision belongs in front of, and putting it in front of whichever
/// one sorts first is exactly the "route a founder's decision through the
/// wrong party" failure design point 3 forbids. The caller re-deadlines
/// instead, which is the behaviour this whole arm had before the last hop
/// existed.
///
/// Queries at most two rows: "is there exactly one" is answerable from two,
/// and a community can have thousands of members.
async fn find_unique_owner(
    tenant: &TenantContext,
    state: &AppState,
) -> Result<Option<PublicKey>, String> {
    let owners = state
        .db
        .list_relay_owners(tenant.community(), 2)
        .await
        .map_err(|error| format!("database error resolving the community owner: {error}"))?;
    let [owner_hex] = owners.as_slice() else {
        return Ok(None);
    };
    PublicKey::from_hex(owner_hex)
        .map(Some)
        .map_err(|error| format!("stored owner pubkey is not valid hex: {error}"))
}

// ---------------------------------------------------------------------
// Stall detection (spec: dead agents)
// ---------------------------------------------------------------------

/// Environment variable naming how long (seconds) a task may sit `inProgress`
/// with no real event activity before [`run_stall_tick`] files a `stall` ask
/// about it. See [`DEFAULT_STALL_AFTER_SECS`] for the default.
pub const STALL_AFTER_SECS_ENV: &str = "BUZZ_STALL_AFTER_SECS";

/// Default value of [`STALL_AFTER_SECS_ENV`]: six hours.
pub const DEFAULT_STALL_AFTER_SECS: i64 = 6 * 60 * 60;

/// Synthetic `initiative` grouping value for a stall ask on a task whose
/// head carries no `initiativeId` at all -- a legitimate state (e.g. an
/// implicit, chat-derived task), and precisely the kind of task most likely
/// to go silently stalled since nobody deliberately organized it under an
/// initiative. Skipping these would carve a hole in the stall guarantee.
///
/// The Ask schema requires exactly one `initiative` tag
/// (`buzz_core::interrupt::parse_ask`) and the `asks` projection's
/// `initiative_id` column is `NOT NULL`, so a genuine `None` cannot flow
/// through as-is without a schema change. This is NOT a real initiative id
/// -- it is a reserved sentinel that only ever appears as the `initiative`
/// tag on a stall ask filed under this exact condition. Dedupe stays exact
/// even though every no-initiative task shares this same grouping value,
/// because [`stall_need_key`] is already unique per task on its own; the
/// composite `(initiative_id, need_key)` uniqueness the dedupe index
/// enforces still lands on one open row per task.
pub const NO_INITIATIVE_SENTINEL: &str = "no-initiative";

/// Upper bound on in-progress task heads scanned per [`run_stall_tick`] pass.
/// Status filtering already happens in SQL before this cap is applied (see
/// [`buzz_db::event::query_in_progress_task_heads`]), so this only bounds a
/// single community with an implausibly large number of simultaneously
/// in-progress tasks -- a write-volume concern, not something this sweep
/// needs to absorb in one pass; the next tick picks up whatever did not fit.
const MAX_STALL_CANDIDATES: i64 = 500;

/// Upper bound on orphaned `promoted` ask rows reopened per [`run_stall_tick`]
/// pass (see [`reopen_orphaned_promotions`]). A true process crash in the
/// narrow window `promote_to` describes should be rare; this bounds a single
/// pass without needing to claim/re-arm the way the ask-deadline sweep does,
/// since an orphan left over one tick is simply reconsidered on the next.
const MAX_ORPHANED_PROMOTIONS: i64 = 100;

/// Run one stall-detection sweep pass (spec: dead agents).
///
/// Finds every currently in-progress task whose most recent real event
/// activity -- not merely its head's own `created_at` -- is at least
/// `stall_after_secs` old, and files one relay-signed [`AskType::Stall`] ask
/// per silent task, addressed to whoever is accountable for it. Also reopens
/// any `promoted` ask left orphaned by a genuine process crash in
/// [`promote_to`]'s narrow claim-then-file window (see
/// [`reopen_orphaned_promotions`]).
///
/// `now_secs` is an explicit parameter for the same reason as
/// [`run_interrupt_tick`]'s: tests drive it deterministically. Requires a
/// durable relay signing key ([`run_interrupt_tick`]'s module docs explain
/// why); refuses the whole tick outright rather than attempting a partial,
/// unsigned-equivalent sweep.
///
/// Returns the number of NEW stall asks filed. A task that is silent but
/// already has an open stall ask (dedupe via [`stall_need_key`]) does not
/// count again; neither does the orphaned-promotion cleanup, which is
/// logged separately.
pub async fn run_stall_tick(
    state: &Arc<AppState>,
    now_secs: i64,
    stall_after_secs: i64,
) -> Result<u32, String> {
    if state.config.relay_private_key.is_none() {
        return Err(
            "stall sweep requires a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .to_string(),
        );
    }

    reopen_orphaned_promotions(state, now_secs, stall_after_secs).await;

    let candidates = state
        .db
        .query_in_progress_task_heads(MAX_STALL_CANDIDATES)
        .await
        .map_err(|error| format!("database error scanning in-progress task heads: {error}"))?;

    // I5: the managed-agent roster (owner-authorship-verified, per
    // community) is memoised for the duration of this one pass rather than
    // re-fetched per candidate task. Without this, N silent tasks in the
    // same community each re-issue the SAME roster scan (one `query_events`
    // plus one membership lookup per candidate head in it), so a community
    // with 100 silent tasks and 50 agents costs up to 5,000 sequential
    // queries on every tick instead of one roster fetch reused 100 times.
    // The trust rule itself is untouched -- see
    // `fetch_owner_authored_managed_agent_roster`'s doc comment -- this only
    // avoids redundantly re-deriving the SAME answer within one pass.
    let mut roster_cache: std::collections::HashMap<CommunityId, ManagedAgentRoster> =
        std::collections::HashMap::new();

    let mut filed = 0u32;
    for candidate in &candidates {
        match process_stall_candidate(
            state,
            candidate,
            now_secs,
            stall_after_secs,
            &mut roster_cache,
        )
        .await
        {
            Ok(true) => filed += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(
                    task_head_event_id = %hex::encode(&candidate.task_head_id),
                    community_id = %candidate.community_id,
                    %error,
                    "stall sweep: failed to process one candidate task, continuing with any siblings"
                );
            }
        }
    }
    Ok(filed)
}

/// Process one in-progress task head candidate: measure whether it has shown
/// real event activity within `stall_after_secs`, and if not, resolve a
/// safe audience and file a relay-signed `stall` ask.
///
/// Returns `Ok(true)` if a new stall ask was filed; `Ok(false)` if the task
/// is not (yet) silent long enough, an open stall ask already exists for it
/// (the dedupe index refused the insert as [`AskBrokerOutcome::Duplicate`]),
/// or no safe audience could be resolved (design point 3: never guess).
///
/// `roster_cache` (I5) memoises each community's owner-authored
/// managed-agent roster for the caller's entire [`run_stall_tick`] pass --
/// see that function's doc comment.
async fn process_stall_candidate(
    state: &Arc<AppState>,
    candidate: &buzz_db::event::StallCandidateTask,
    now_secs: i64,
    stall_after_secs: i64,
    roster_cache: &mut std::collections::HashMap<CommunityId, ManagedAgentRoster>,
) -> Result<bool, String> {
    let task: CompanyTask = match serde_json::from_str(&candidate.content) {
        Ok(task) => task,
        Err(error) => {
            // An unparseable task head content is an invariant violation for
            // a relay-authored canonical head (every write goes through
            // `buzz_core::company::validate_task` first), not something this
            // sweep can repair. Log and move on to the next candidate.
            tracing::warn!(
                task_head_event_id = %hex::encode(&candidate.task_head_id),
                community_id = %candidate.community_id,
                %error,
                "stall sweep: task head content failed to parse, skipping"
            );
            return Ok(false);
        }
    };

    let Ok(source_channel_id) = uuid::Uuid::parse_str(&task.source_channel_id) else {
        tracing::warn!(
            task_id = %task.id,
            community_id = %candidate.community_id,
            "stall sweep: task head's sourceChannelId is not a valid UUID, skipping"
        );
        return Ok(false);
    };

    // `candidate.host` already comes from `query_in_progress_task_heads`'s
    // own `communities` join, which the same query filters to
    // `archived_at IS NULL` -- no separate host lookup needed here (unlike
    // `process_due_ask`, which resolves a row's community after the fact).
    let tenant = TenantContext::resolved(candidate.community_id, candidate.host.clone());

    // I5: fetch this community's owner-authored managed-agent roster once
    // per `run_stall_tick` pass and reuse it for every candidate task in
    // that community, rather than re-querying per candidate. Moved ahead of
    // the silence measurement below: resolving the task's assignees to
    // agent pubkeys needs the roster before the signal can be computed.
    if let std::collections::hash_map::Entry::Vacant(entry) =
        roster_cache.entry(candidate.community_id)
    {
        let roster =
            fetch_owner_authored_managed_agent_roster(&tenant, state, MAX_ROSTER_HEADS).await?;
        entry.insert(roster);
    }
    let roster = roster_cache
        .get(&candidate.community_id)
        .expect("just inserted or already present");

    // Silence means the ASSIGNED AGENTS have gone event-silent, not merely
    // that the head is old: the signal is the most recent of (a) the task
    // head's own `created_at` (a status change is itself activity) and (b)
    // the newest event AUTHORED BY any of the task's resolvable assignee
    // agents, anywhere in the community. An agent that is alive keeps
    // producing events (messages, task updates, asks); a busy channel no
    // longer vouches for a dead one.
    //
    // KNOWN FALSE NEGATIVE, now confined to the fallback: a task none of
    // whose `assignee_persona_ids` resolve to a running agent in the
    // owner-authored roster cannot be measured per-agent, so it falls back
    // to the old channel-activity signal, where any chatter in
    // `source_channel_id` suppresses detection. Accepted: for an
    // unattributable task the channel is still the best signal available,
    // and filing stall asks on every quiet-headed task with an active
    // channel would be the queue-spam failure this system exists to prevent.
    let mut assignee_pubkeys: Vec<PublicKey> = Vec::new();
    for persona_id in &task.assignee_persona_ids {
        if let Some(pubkey) = persona_pubkey_in_roster(roster, persona_id)? {
            assignee_pubkeys.push(pubkey);
        }
    }

    let mut activity: Vec<i64> = Vec::new();
    if assignee_pubkeys.is_empty() {
        let channel_last_activity = state
            .db
            .get_last_message_at(candidate.community_id, source_channel_id)
            .await
            .map_err(|error| format!("database error loading channel activity: {error}"))?;
        if let Some(at) = channel_last_activity {
            activity.push(at.timestamp());
        }
    } else {
        for pubkey in &assignee_pubkeys {
            let last = state
                .db
                .get_last_authored_event_at(candidate.community_id, pubkey.as_bytes())
                .await
                .map_err(|error| format!("database error loading agent activity: {error}"))?;
            if let Some(at) = last {
                activity.push(at.timestamp());
            }
        }
    }
    let head_created_at = candidate.task_head_created_at.timestamp();
    let last_activity_secs = activity
        .into_iter()
        .chain(std::iter::once(head_created_at))
        .max()
        .unwrap_or(head_created_at);
    let silent_for_secs = now_secs.saturating_sub(last_activity_secs);
    if silent_for_secs < stall_after_secs {
        return Ok(false);
    }

    // `need_key` alone is already unique per task (it is a hash of `task.id`),
    // but the dedupe index is keyed on `(initiative_id, need_key)` together
    // (`buzz_db::asks`'s module docs), so if a task's `initiativeId` changes
    // while a stall ask on it is still open, a later tick could in principle
    // file a second open stall ask under the new initiative before the first
    // is answered. Narrow (a task is unlikely to be reassigned mid-stall) and
    // not solved here -- flagged as a known limitation rather than silently
    // accepted.
    let need_key = stall_need_key(&task.id);
    let initiative_id = task
        .initiative_id
        .clone()
        .unwrap_or_else(|| NO_INITIATIVE_SENTINEL.to_string());

    // I4 fix: a human closing a stall ask (resolving or withdrawing it) is a
    // decisive act -- "the agent died, I'll deal with it Monday" -- and must
    // not be silently overridden a tick later just because the dedupe index
    // is only partial on `status = 'open'` (closing the ask frees the slot
    // for a fresh filing) and this task still measures as silent from
    // BEFORE that closure. Re-filing here would be the exact queue-spam
    // failure this whole system exists to prevent. Only re-file if genuine
    // NEW activity (a later head revision or channel message) has occurred
    // since the closure; otherwise the "silence" being measured right now
    // is the SAME silence a human already acted on.
    if let Some(closed) = state
        .db
        .find_latest_closed_ask_by_need(candidate.community_id, &initiative_id, &need_key)
        .await
        .map_err(|error| format!("database error checking prior stall ask closure: {error}"))?
    {
        if closed.updated_at >= last_activity_secs {
            return Ok(false);
        }
    }

    let audience = match persona_pubkey_in_roster(roster, &task.qa_persona_id)? {
        Some(pubkey) => pubkey,
        None => match unique_executive_in_roster(roster)? {
            Some(pubkey) => pubkey,
            None => {
                // Design point 2/3: a brand-new community (no appointed
                // executive yet) or a QA persona this sweep cannot uniquely
                // resolve to a running agent must never be guessed at --
                // there is nowhere safe to route this stall ask. Skip
                // rather than spam, mirroring `promote_or_redeadline`'s
                // identical "nowhere safe to go" reasoning.
                tracing::warn!(
                    task_id = %task.id,
                    community_id = %candidate.community_id,
                    "stall sweep: cannot resolve a QA persona or a unique executive for a \
                     silent task; never guessing an audience, skipping"
                );
                return Ok(false);
            }
        },
    };

    let content = serde_json::json!({
        "headline": format!("\"{}\" has gone silent", task.title),
        "cost_of_delay": format!(
            "no activity on this task for {silent_for_secs}s -- the agent working it may have \
             crashed, hung, or stopped"
        ),
    })
    .to_string();

    let tags = vec![
        Tag::parse(["ask-type", AskType::Stall.as_str()])
            .map_err(|error| format!("failed to build `ask-type` tag: {error}"))?,
        Tag::public_key(audience),
        Tag::parse(["initiative", &initiative_id])
            .map_err(|error| format!("failed to build `initiative` tag: {error}"))?,
        Tag::parse(["need", &need_key])
            .map_err(|error| format!("failed to build `need` tag: {error}"))?,
        Tag::parse(["task", &task.id])
            .map_err(|error| format!("failed to build `task` tag: {error}"))?,
    ];

    let event = EventBuilder::new(Kind::Custom(KIND_ASK as u16), content)
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
        .map_err(|error| format!("failed to sign stall ask: {error}"))?;

    let outcome = handle_ask_event(&tenant, state, &event)
        .await
        .map_err(|error| format!("failed to file stall ask: {error}"))?;
    match outcome {
        AskBrokerOutcome::Applied => {}
        AskBrokerOutcome::Duplicate { .. } => {
            // An open stall ask already exists for this exact task -- the
            // dedupe index did its job; nothing more to do.
            return Ok(false);
        }
        AskBrokerOutcome::Refused { message } => {
            return Err(format!(
                "internal error: relay-signed stall ask was refused: {message}"
            ));
        }
    }

    // Store and fan out the raw event, mirroring `promote_to`/`execute_default`:
    // ask-protocol events are never consumed by the broker (see
    // `ask_broker`'s module docs), so the sweep takes on ordinary storage's
    // responsibility here. Best-effort: the ask is already durably open via
    // the `asks` projection row above, so a storage/fan-out failure here
    // only costs realtime visibility, not correctness.
    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, None)
        .await
    {
        tracing::warn!(%error, "stall sweep: failed to store the stall ask event");
    } else if let Err(error) = state
        .pubsub
        .publish_event(&tenant, buzz_pubsub::EventTopic::Global, &event)
        .await
    {
        tracing::warn!(%error, "stall sweep: failed to fan out the stall ask event");
    }

    Ok(true)
}

/// Build the Ask `need` dedupe key for a stall on `task_id`.
///
/// A Colony task id (see `buzz_core::company`'s `validate_id`) may contain
/// `.`, `_`, and `:`, and run up to 128 bytes -- none of which fits the Ask
/// `need` slug format `[a-z0-9-]{1,64}` that
/// `buzz_core::interrupt::parse_ask`'s `is_valid_need_slug` enforces.
/// Hashing the task id, rather than embedding it directly, keeps every legal
/// task id valid, produces a key that is stable across ticks (so the SAME
/// task always dedupes against itself), and needs no assumption about the
/// id's actual character set. 128 bits of SHA-256 (32 hex characters) is
/// collision-resistant enough for an internal dedupe key.
pub fn stall_need_key(task_id: &str) -> String {
    let digest = Sha256::digest(task_id.as_bytes());
    format!("stall-{}", hex::encode(&digest[..16]))
}

/// Resolve `persona_id` (e.g. a task's `qaPersonaId`) to the pubkey of the
/// managed agent currently running as that persona, from an already-fetched
/// [`ManagedAgentRoster`].
///
/// The roster's content is scanned for one entry whose `persona_id` field
/// matches -- the same field `desktop/src-tauri/src/managed_agents/agent_events.rs`'s
/// `ManagedAgentEventContent` already publishes today. Parsed as untyped
/// JSON rather than through that desktop-only type (this crate does not
/// depend on the desktop crate), exactly like [`agent_tier`] reads the
/// sibling `tier` field.
///
/// Security: `KIND_MANAGED_AGENT` is client-writable (Task 4's finding, see
/// [`fetch_owner_authored_managed_agent_roster`]'s doc comment) -- any agent
/// could otherwise publish a head claiming `persona_id: "cto"` and make
/// itself the recipient of every stall ask about the CTO's work, an
/// information leak that also keeps the real accountable party in the dark.
/// The roster this reads already carries that owner-authorship trust rule
/// (this function does no additional filtering, and does no I/O of its
/// own): only heads authored by a CURRENT community owner were ever
/// included in it.
///
/// `Ok(None)` -- never guessed, design point 3 -- when zero, or more than
/// one, distinct currently-owner-claimed pubkey names this persona (the
/// latter is ambiguous authority: two owner-authored heads disagreeing on
/// who runs a persona is not this function's call to arbitrate). The
/// caller falls back to the community's executive in that case.
fn persona_pubkey_in_roster(
    roster: &ManagedAgentRoster,
    persona_id: &str,
) -> Result<Option<PublicKey>, String> {
    let mut matches: std::collections::HashSet<[u8; 32]> = std::collections::HashSet::new();
    for (d_tag, content) in roster {
        if content
            .get("persona_id")
            .and_then(serde_json::Value::as_str)
            != Some(persona_id)
        {
            continue;
        }
        let Ok(pubkey_bytes) = hex::decode(d_tag) else {
            continue;
        };
        if let Ok(pubkey) = PublicKey::from_slice(&pubkey_bytes) {
            matches.insert(*pubkey.as_bytes());
        }
    }

    if matches.len() == 1 {
        let bytes = matches
            .into_iter()
            .next()
            .expect("checked matches.len() == 1 above");
        PublicKey::from_slice(&bytes)
            .map(Some)
            .map_err(|error| format!("resolved persona pubkey is invalid: {error}"))
    } else {
        Ok(None)
    }
}

/// Reopen every `promoted` ask that is a genuine orphan -- the Task 8 crash
/// residual [`promote_to`]'s doc comment describes: a genuine process
/// crash in the narrow window between [`buzz_db::Db::mark_ask_promoted`]
/// committing and the successor ask being filed leaves the original
/// permanently `promoted` toward an event that does not exist, and the
/// need then has no open ask at any tier. No in-process compensation
/// survives that crash; this is the out-of-process backstop.
///
/// [`buzz_db::asks::query_orphaned_promoted_asks`] specifically excludes
/// `promote_to`'s `Duplicate` arm (a discarded successor that lost a race
/// against a DIFFERENT ask claiming the same need) from this -- see that
/// function's doc comment for why a weaker "does the exact named successor
/// exist" check would wrongly resurrect a need that was correctly
/// superseded, potentially well after the winner has itself resolved.
///
/// Best-effort at every level: a failure to even scan for orphans, or to
/// reopen one particular orphan, is logged and swallowed rather than
/// propagated. Nothing about the primary job of [`run_stall_tick`] --
/// filing stall asks for silent tasks -- depends on this cleanup succeeding,
/// and an orphan left over one tick is simply reconsidered on the next.
async fn reopen_orphaned_promotions(state: &Arc<AppState>, now_secs: i64, stall_after_secs: i64) {
    // Reuses `stall_after_secs` as the grace period before a mid-flight
    // promotion (claim committed a moment ago, successor not yet filed --
    // normally milliseconds) could be mistaken for a true orphan, rather
    // than introducing a second env var for what is already a generous
    // multi-hour default.
    let cutoff = now_secs.saturating_sub(stall_after_secs);
    let orphans = match state
        .db
        .query_orphaned_promoted_asks(cutoff, MAX_ORPHANED_PROMOTIONS)
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::warn!(
                %error,
                "stall sweep: failed to scan for orphaned promoted asks, skipping this pass"
            );
            return;
        }
    };

    for row in &orphans {
        let Some(expected_successor) = row.resolution_event.as_deref() else {
            // Invariant: a `promoted` row always names its successor
            // (`mark_ask_promoted` always sets `resolution_event`) --
            // `query_orphaned_promoted_asks` should never actually produce
            // one without it, but this sweep does not act on a shape it
            // cannot explain.
            continue;
        };
        match state
            .db
            .reopen_promoted_ask(row.community_id, &row.ask_event_id, expected_successor)
            .await
        {
            Ok(true) => {
                tracing::info!(
                    ask_event_id = %hex::encode(&row.ask_event_id),
                    community_id = %row.community_id,
                    "stall sweep: reopened a promoted ask whose successor was never created \
                     (Task 8 crash residual)"
                );
            }
            Ok(false) => {
                // Already reverted or closed some other way in the
                // meantime -- not this pass's problem either way.
            }
            Err(error) => {
                tracing::warn!(
                    ask_event_id = %hex::encode(&row.ask_event_id),
                    community_id = %row.community_id,
                    %error,
                    "stall sweep: failed to reopen an orphaned promoted ask, continuing with \
                     any siblings"
                );
            }
        }
    }
}
