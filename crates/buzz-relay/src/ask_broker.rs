//! Colony interrupt-core: the Ask broker (spec: broker).
//!
//! Turns a signed Ask (kind 44300), Ask resolution (kind 44301), or Ask
//! withdrawal (kind 44302) into the altitude-checked, deduped, deadline-
//! stamped `asks` projection row [`crate`]'s `buzz-db` sibling crate built
//! (Task 3), plus -- for resolutions and withdrawals -- a relay-signed
//! receipt posted back into the thread the blocked agent is waiting in.
//!
//! Unlike [`crate::company_broker`], ask-protocol events are never
//! consumed: every accepted event carries on through the ordinary storage
//! path so channels and future UI can subscribe to it like any other event.
//! This module only does the pre-storage bookkeeping (parse, authorize,
//! dedupe, and -- for resolutions/withdrawals -- close the row and wake the
//! filer) that has to happen before an ask-protocol event is allowed to
//! land.
//!
//! Altitude: a `Worker` may only raise an ask to its `Leader`, a `Leader`
//! only to the `Executive`, and the `Executive` only to a community owner.
//! Relay-signed asks bypass the ladder entirely -- Tasks 8 and 9 file
//! promotions and stalls that way. A signer with no recognized tier
//! (a human, or an unmanaged client) can never file: owners answer asks,
//! they do not file them.
//!
//! [`try_auto_resolve_from_reply`] is the odd one out: it runs AFTER
//! storage, on ordinary kind 9/40002 messages rather than an ask-protocol
//! kind, when an owner answers by replying in the thread instead of
//! tapping the Ask card.

use std::sync::Arc;

use buzz_core::interrupt::{
    parse_ask, parse_resolution, parse_withdrawal, AgentTier, AskType, ParsedAsk,
};
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_COMPANY_PROFILE, KIND_STREAM_MESSAGE,
    KIND_STREAM_MESSAGE_V2,
};
use buzz_core::tenant::TenantContext;
use buzz_db::asks::{AskRow, NewAskRow};
use nostr::{Event, EventBuilder, Kind, PublicKey, Tag};

use crate::interrupt_gate::{agent_tier, extract_thread_root};
use crate::state::AppState;

/// Default filing-to-deadline window, in seconds, used when neither the
/// ask's own content nor the community's company profile head names one.
const DEFAULT_ASK_WINDOW_SECS: u64 = 3600;

/// What ingest should report back to the requesting client after an
/// ask-protocol event (kind 44300-44302) is brokered.
///
/// Shaped like [`crate::company_broker::CompanyBrokerOutcome`], but
/// `Applied` means something different here: "the broker's pre-storage
/// checks passed; let the event continue through ordinary storage" rather
/// than "already stored and dispatched". Ask events are never consumed.
#[derive(Debug)]
pub enum AskBrokerOutcome {
    /// The broker's checks passed (a new ask was filed, or an open ask was
    /// resolved/withdrawn). Ingest should fall through to standard event
    /// storage.
    Applied,
    /// An open ask already exists for this `(initiative, need)`; this
    /// filing is a duplicate and must not be stored again.
    Duplicate {
        /// Raw event ID of the ask that originally claimed this need.
        original_ask_event_id: [u8; 32],
    },
    /// The request was well-formed but lost (bad altitude, unauthorized
    /// signer, unknown/closed ask, ...). The event must not be stored.
    Refused {
        /// Display-safe reason the request was refused.
        message: String,
    },
}

/// Whether `event` is a Colony interrupt Ask-protocol event (kind 44300,
/// 44301, or 44302) and belongs to this broker.
pub fn is_ask_candidate(event: &Event) -> bool {
    matches!(
        event.kind.as_u16() as u32,
        KIND_ASK | KIND_ASK_RESOLUTION | KIND_ASK_WITHDRAWAL
    )
}

/// Broker one ask-protocol event: file (44300), resolve (44301), or
/// withdraw (44302).
///
/// `Err` is an internal/database failure and should be reported as a
/// rejection with no storage attempted; everything a legitimately signed
/// event can lose to comes back as `Ok(AskBrokerOutcome::Refused)` or
/// `Ok(AskBrokerOutcome::Duplicate)` instead.
pub async fn handle_ask_event(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<AskBrokerOutcome, String> {
    match event.kind.as_u16() as u32 {
        KIND_ASK => handle_ask(tenant, state, event).await,
        KIND_ASK_RESOLUTION => handle_resolution(tenant, state, event).await,
        KIND_ASK_WITHDRAWAL => handle_withdrawal(tenant, state, event).await,
        _ => Err("internal error: event is not an ask-protocol kind".to_string()),
    }
}

/// File a new Ask (kind 44300): parse, enforce the altitude ladder, dedupe
/// against any currently-open ask for the same need, stamp a deadline, and
/// insert the `asks` projection row.
async fn handle_ask(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<AskBrokerOutcome, String> {
    let parsed = match parse_ask(event) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(AskBrokerOutcome::Refused {
                message: error.to_string(),
            })
        }
    };

    if let Some(message) = check_altitude(tenant, state, event, &parsed).await? {
        return Ok(AskBrokerOutcome::Refused { message });
    }

    if let Some(existing) = state
        .db
        .find_open_ask_by_need(tenant.community(), &parsed.initiative_id, &parsed.need_key)
        .await
        .map_err(|error| format!("database error checking for a duplicate ask: {error}"))?
    {
        return Ok(AskBrokerOutcome::Duplicate {
            original_ask_event_id: ask_row_event_id(&existing)?,
        });
    }

    let window_secs = match parsed.default_window_secs {
        Some(secs) => secs,
        None => company_ask_window_secs(tenant, state).await,
    };
    // `parse_ask` already bounds the ask's own `default_window_secs` at
    // `MAX_ASK_WINDOW_SECS`, but the company default read above comes from
    // a DIFFERENT, relay/owner-authored event's content and is never run
    // through that validation. Clamp here too (defense in depth) and use
    // `saturating_add` rather than a raw cast-and-add: an unbounded u64
    // cast to i64 can reinterpret as negative, landing the deadline in the
    // past and firing the default-on-timeout answer immediately -- exactly
    // the "acting without waiting for the human" a deadline exists to
    // prevent.
    let window_secs = window_secs.min(buzz_core::interrupt::MAX_ASK_WINDOW_SECS);
    let deadline_at = event.created_at.as_secs().saturating_add(window_secs) as i64;

    let audience_bytes = PublicKey::from_hex(&parsed.audience_hex)
        .map_err(|_| "internal error: audience hex is not a valid pubkey".to_string())?
        .to_bytes()
        .to_vec();
    let origin_thread_bytes = decode_hex64(parsed.origin_thread_hex.as_deref())?;
    let prior_ask_bytes = decode_hex64(parsed.prior_ask_hex.as_deref())?;
    let filer_bytes = resolve_filer(state, event, &parsed)?.to_bytes().to_vec();

    // Dedupe above is check-then-act: two filers can both pass
    // `find_open_ask_by_need` before either commits, so the loser's insert
    // below can still hit the `asks_open_need_uniq` partial unique index
    // directly. Losing that race must read the same as losing the
    // pre-check -- a `Duplicate` naming the winner -- not a raw database
    // error the losing agent has no way to act on (spec: five agents
    // blocked on one missing API key must produce one ask, not four errors
    // and one ask).
    match state
        .db
        .insert_ask(
            tenant.community(),
            NewAskRow {
                ask_event_id: event.id.as_bytes(),
                ask_type: parsed.ask_type.as_str(),
                initiative_id: &parsed.initiative_id,
                need_key: &parsed.need_key,
                audience_pubkey: &audience_bytes,
                filer_pubkey: &filer_bytes,
                origin_thread: origin_thread_bytes.as_deref(),
                prior_ask: prior_ask_bytes.as_deref(),
                category: parsed.category.as_deref(),
                default_option: parsed.default_option.as_deref(),
                deadline_at: Some(deadline_at),
            },
        )
        .await
    {
        Ok(()) => {
            if let Some(prior) = prior_ask_bytes.as_deref() {
                close_superseded_prior(tenant, state, prior, event, &parsed).await;
            }
            Ok(AskBrokerOutcome::Applied)
        }
        Err(error) if is_unique_violation(&error) => {
            let winner = state
                .db
                .find_open_ask_by_need(tenant.community(), &parsed.initiative_id, &parsed.need_key)
                .await
                .map_err(|error| {
                    format!("database error re-checking after a filing race: {error}")
                })?
                .ok_or_else(|| {
                    "internal error: lost an insert race but no open ask now exists for this need"
                        .to_string()
                })?;
            Ok(AskBrokerOutcome::Duplicate {
                original_ask_event_id: ask_row_event_id(&winner)?,
            })
        }
        Err(error) => Err(format!("database error filing ask: {error}")),
    }
}

/// Where a pubkey sits on the altitude ladder, as a comparable rank:
/// worker 0, leader 1, executive 2, community owner 3.
///
/// Owner is checked first and independently of any managed-agent head: a
/// human owner is the top of the ladder whether or not anyone ever published
/// a head about them. `Ok(None)` means the pubkey sits nowhere on the ladder
/// this relay can currently establish, and the caller must decline rather
/// than assume.
async fn audience_altitude(
    tenant: &TenantContext,
    state: &AppState,
    audience_hex: &str,
) -> Result<Option<u8>, String> {
    let is_owner = state
        .db
        .get_relay_member(tenant.community(), audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience role: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if is_owner {
        return Ok(Some(3));
    }
    let audience = PublicKey::from_hex(audience_hex)
        .map_err(|_| "internal error: audience hex is not a valid pubkey".to_string())?;
    Ok(agent_tier(tenant, state, &audience)
        .await?
        .map(|tier| match tier {
            AgentTier::Worker => 0,
            AgentTier::Leader => 1,
            AgentTier::Executive => 2,
        }))
}

/// Close the still-open ask that a just-accepted manual escalation's `prior`
/// tag points at, when the successor genuinely sits HIGHER on the altitude
/// ladder than it does (I5).
///
/// `prior` used to be a provenance pointer only: `buzz asks escalate` left
/// the ask it escalated from wide open, and nothing else closed it. After a
/// worker -> leader -> executive -> owner chain that left three open rows for
/// one underlying need, with two consequences the protocol is explicitly sold
/// against. A second agent blocked on the same thing deduped onto the LOWEST,
/// stalest ask instead of the one actually in front of the owner, which is
/// the opposite of the convergence property the `need` key exists for. And
/// the interrupt sweep independently auto-promoted that stale row, generating
/// yet another ask for the same need. Doing this in the broker rather than in
/// `buzz-cli` means it holds for any client, not only ours.
///
/// **Three independent authorization checks, none of them a formality.**
/// `prior` is an unauthenticated tag naming any event id in the community,
/// and `check_altitude` only constrains signer-versus-audience, so closing
/// whatever it names would hand every agent a withdrawal power the protocol
/// reserves for the executive:
///
/// 1. **Standing.** The prior ask's audience must BE the successor's signer,
///    which is what a legitimate escalation looks like. Without it, any
///    leader could close any other agent's open leader-audience ask.
/// 2. **Not a stall ask.** A `stall` ask is relay-filed about a silent task,
///    and closing one suppresses the stall sweep's re-detection of that task.
/// 3. **Strictly higher altitude.** Without it, a worker could close the
///    executive's ask sitting in front of the owner by filing an ordinary
///    worker-to-leader ask that points `prior` at it.
///
/// Anything this function cannot establish -- a prior row that is not open, a
/// signer without standing, a stall ask, a rank it cannot resolve on either
/// side, a successor that is not strictly higher -- is left alone.
///
/// Best-effort throughout: the successor is already durably filed by the time
/// this runs, and failing to close its predecessor must not turn an accepted
/// escalation into a rejection. The worst case is the pre-I5 behaviour.
///
/// Requires a durable relay signing key, the same guard
/// [`handle_resolution`] and [`handle_withdrawal`] enforce and for the same
/// reason: this signs a canonical "stand down" record. Without one those two
/// paths already refuse outright, so the whole closing half of the protocol
/// is inoperative anyway and declining here changes nothing a dev install
/// could otherwise do.
///
/// No wake-up receipt is posted. A receipt tells a blocked agent its ask was
/// answered; here the work is continuing one rung up rather than being
/// resolved, and waking the filer back into its stalled thread would say the
/// opposite of what happened.
async fn close_superseded_prior(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    prior_ask_event_id: &[u8],
    successor: &Event,
    parsed: &ParsedAsk,
) {
    if state.config.relay_private_key.is_none() {
        return;
    }

    let prior = match state
        .db
        .find_open_ask_by_event_id(tenant.community(), prior_ask_event_id)
        .await
    {
        // No row, or no longer open (already resolved, withdrawn, or
        // promoted -- the relay's own auto-promotion always marks the
        // original `promoted` BEFORE filing its successor, so it never
        // reaches this branch). Nothing to supersede.
        Ok(None) => return,
        Ok(Some(prior)) => prior,
        Err(error) => {
            tracing::warn!(%error, "supersede: failed to load the prior ask row");
            return;
        }
    };

    // Standing: the signer must be the party the prior ask was actually
    // waiting on. Outranking an ask is not the same as having any business
    // with it -- without this, any leader-tier agent could point `prior` at
    // any OTHER agent's open leader-audience ask and close it silently,
    // acquiring by side effect the authority `handle_withdrawal` reserves for
    // the executive. Requiring `prior.audience == successor's signer` is
    // exactly what a legitimate escalation looks like: the leader who
    // received the raise is the one carrying it onward.
    //
    // Deliberately `successor.pubkey` and not `resolve_filer`: the relay's
    // own auto-promotion never reaches here (it marks the original
    // `promoted` before filing the successor, so the lookup above already
    // returned `None`), so there is no relay-signed case to accommodate, and
    // honouring a `filer` tag here would reintroduce the same hole under a
    // different name.
    if prior.audience_pubkey != successor.pubkey.to_bytes().to_vec() {
        return;
    }

    // A `stall` ask is relay-filed about a task that stopped moving. Nobody
    // escalated it to anyone, so the audience relationship above does not
    // mean what it means for a raise -- and the stall sweep treats ANY
    // closure of one as a decisive human act, suppressing re-detection of
    // that exact task until fresh activity appears
    // (`interrupt_runtime::process_stall_candidate`'s
    // `find_latest_closed_ask_by_need` check). Closing one as a side effect
    // of filing something else would therefore disarm the single thing the
    // stall sweep exists to catch: an agent that died silently. A human can
    // still close it deliberately through resolution or withdrawal.
    if prior.ask_type == AskType::Stall.as_str() {
        return;
    }

    let prior_hex = hex::encode(&prior.audience_pubkey);
    let ranks = tokio::join!(
        audience_altitude(tenant, state, &prior_hex),
        audience_altitude(tenant, state, &parsed.audience_hex),
    );
    let (Ok(Some(prior_rank)), Ok(Some(successor_rank))) = ranks else {
        tracing::warn!(
            prior_ask_event_id = %hex::encode(prior_ask_event_id),
            "supersede: could not place both asks on the altitude ladder; leaving the prior open"
        );
        return;
    };
    if successor_rank <= prior_rank {
        return;
    }

    let reason = format!(
        "superseded by ask {}, filed one tier higher; this ask is no longer waiting on anyone",
        successor.id.to_hex()
    );
    let content = serde_json::json!({ "reason": reason }).to_string();
    let withdrawal = match EventBuilder::new(Kind::Custom(KIND_ASK_WITHDRAWAL as u16), content)
        .tags(vec![
            match Tag::parse(["e", &hex::encode(prior_ask_event_id)]) {
                Ok(tag) => tag,
                Err(error) => {
                    tracing::warn!(%error, "supersede: failed to build withdrawal `e` tag");
                    return;
                }
            },
        ])
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(withdrawal) => withdrawal,
        Err(error) => {
            tracing::warn!(%error, "supersede: failed to sign the supersede withdrawal");
            return;
        }
    };

    // Claim before side effect, matching every other transition here: the
    // conditional `UPDATE ... WHERE status = 'open'` runs before the
    // withdrawal event is stored or fanned out.
    match state
        .db
        .withdraw_ask(
            tenant.community(),
            prior_ask_event_id,
            withdrawal.id.as_bytes(),
        )
        .await
    {
        Ok(true) => {}
        // Lost a race against something that closed the prior a moment
        // earlier; the signed withdrawal is simply discarded.
        Ok(false) => return,
        Err(error) => {
            tracing::warn!(%error, "supersede: failed to close the prior ask");
            return;
        }
    }

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &withdrawal, None)
        .await
    {
        tracing::warn!(%error, "supersede: failed to store the supersede withdrawal");
    } else if let Err(error) = state
        .pubsub
        .publish_event(tenant, buzz_pubsub::EventTopic::Global, &withdrawal)
        .await
    {
        tracing::warn!(%error, "supersede: failed to fan out the supersede withdrawal");
    }
}

/// After a resolution closes an ask that superseded a prior (a manual
/// escalation chain), wake the PRIOR's filer too: the answer belongs to
/// whoever was originally blocked, not only to the agent that carried the
/// ask upward. Additive and best-effort -- the audience receipt has
/// already gone out.
///
/// `prior` is an unauthenticated tag (see [`close_superseded_prior`]), so
/// the same standing rule gates this wake: the prior ask's audience must
/// BE the resolved ask's signer, and a relay-filed stall prior is never
/// woken this way. Without those checks an agent could point `prior` at
/// any ask in the community and have the relay deliver "resolved" wake-ups
/// to its filer.
async fn wake_superseded_prior_filer(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    successor_event: &Event,
    successor_ask: &ParsedAsk,
) {
    let Some(prior_hex) = &successor_ask.prior_ask_hex else {
        return;
    };
    let Ok(prior_bytes) = hex::decode(prior_hex) else {
        return;
    };
    let prior = match state
        .db
        .find_ask_by_event_id(tenant.community(), &prior_bytes)
        .await
    {
        Ok(Some(prior)) => prior,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(%error, "upstream wake: failed to load the prior ask row");
            return;
        }
    };
    if prior.ask_type == AskType::Stall.as_str() {
        return;
    }
    if prior.audience_pubkey != successor_event.pubkey.to_bytes().to_vec() {
        return;
    }
    let Some(origin_thread) = &prior.origin_thread else {
        return;
    };
    let Ok(filer) = PublicKey::from_slice(&prior.filer_pubkey) else {
        return;
    };
    // The audience receipt may already have reached this same agent (a
    // self-escalation, or resolve_filer landing on the same key); one wake
    // is enough.
    if let Ok(primary) = resolve_filer(state, successor_event, successor_ask) {
        if primary == filer {
            return;
        }
    }
    emit_ask_receipt(
        tenant,
        state,
        &hex::encode(origin_thread),
        &format!("Ask resolved upstream: {}", successor_ask.headline),
        filer,
        None,
    )
    .await;
}

/// Extract an `AskRow`'s event id as a fixed-size array. The `asks` table
/// only ever stores 32-byte event ids, so a mismatch is an internal
/// invariant violation, not a bad request.
fn ask_row_event_id(row: &buzz_db::asks::AskRow) -> Result<[u8; 32], String> {
    row.ask_event_id
        .as_slice()
        .try_into()
        .map_err(|_| "internal error: stored ask event id is not 32 bytes".to_string())
}

/// Whether `error` is a Postgres unique-constraint violation (SQLSTATE
/// 23505) -- the shape `insert_ask` fails with when it loses a filing race
/// against the `asks_open_need_uniq` partial unique index.
fn is_unique_violation(error: &buzz_db::DbError) -> bool {
    matches!(
        error,
        buzz_db::DbError::Sqlx(sqlx::Error::Database(db_error))
            if db_error.code().as_deref() == Some("23505")
    )
}

/// Decode a tag value `parse_ask`/`parse_resolution`/`parse_withdrawal`
/// already validated as 64-character hex. A decode failure here means an
/// upstream invariant broke, not a bad request from the signer, so it is an
/// internal error rather than a `Refused`.
fn decode_hex64(hex_value: Option<&str>) -> Result<Option<Vec<u8>>, String> {
    match hex_value {
        Some(value) => Ok(Some(hex::decode(value).map_err(|_| {
            "internal error: a validated hex64 field failed to decode".to_string()
        })?)),
        None => Ok(None),
    }
}

/// The effective filer of an ask event: normally its own signer, but for a
/// relay-signed ask carrying an optional `filer` tag (an interrupt-sweep
/// promotion: `interrupt_runtime::promote_to` signs the successor as the
/// relay, not as the original filer), the tag's pubkey instead.
///
/// Without this, every consumer that asks "who is blocked on this ask" --
/// [`handle_ask`]'s own `filer_pubkey` column, and [`handle_resolution`] /
/// [`handle_withdrawal`]'s wake-up receipt, which re-derives the filer from
/// the loaded ask EVENT's signer rather than the `asks` row -- would treat
/// a promoted ask's filer as the relay itself, so every wake-up for it
/// would p-tag the relay instead of the agent actually waiting.
///
/// The tag is honoured ONLY under the exact same relay-identity condition
/// `check_altitude`'s bypass uses (durable key configured AND the ask
/// event's signer is the relay's own key). `parse_ask` extracts `filer_hex`
/// regardless of signer -- it is signer-agnostic -- so an ordinary agent CAN
/// put a `filer` tag on its own filing, but this function simply ignores
/// it: only a relay-signed event's `filer` tag is ever trusted, exactly
/// like `prior` and the altitude bypass itself are relay-only privileges.
fn resolve_filer(
    state: &AppState,
    ask_event: &Event,
    parsed: &ParsedAsk,
) -> Result<PublicKey, String> {
    let is_relay_signed = state.config.relay_private_key.is_some()
        && ask_event.pubkey == state.relay_keypair.public_key();
    if !is_relay_signed {
        return Ok(ask_event.pubkey);
    }
    match &parsed.filer_hex {
        Some(hex) => PublicKey::from_hex(hex)
            .map_err(|_| "internal error: filer hex is not a valid pubkey".to_string()),
        None => Ok(ask_event.pubkey),
    }
}

/// Returns `Some(refusal message)` when `event`'s signer may not address
/// `parsed.audience_hex` under the interrupt altitude ladder (Worker only
/// to Leader, Leader only to Executive, Executive only to a community
/// owner), `None` when the filing may proceed.
///
/// Relay-signed asks bypass the ladder entirely -- Tasks 8 and 9 file
/// promotions and stalls that way. The bypass requires a durable relay key
/// (`state.config.relay_private_key`), same as the relay-signed bypasses on
/// resolution and withdrawal: without one, `state.relay_keypair` is the
/// hardcoded fallback every install shares (`main.rs`'s dev keypair when
/// `BUZZ_RELAY_PRIVATE_KEY` is unset and `require_auth_token` is false), so
/// trusting that identity here would let anyone who reads this repo forge a
/// kind 44300 straight to a human owner with no tier and no membership. The
/// relay pubkey is an authorization credential on the filing path, not
/// merely a signing key, even though filing itself never signs anything.
async fn check_altitude(
    tenant: &TenantContext,
    state: &AppState,
    event: &Event,
    parsed: &ParsedAsk,
) -> Result<Option<String>, String> {
    if state.config.relay_private_key.is_some() && event.pubkey == state.relay_keypair.public_key()
    {
        return Ok(None);
    }

    let Some(signer_tier) = agent_tier(tenant, state, &event.pubkey).await? else {
        // Owners (and any other untiered signer -- a human, or an unmanaged
        // client) answer asks; they do not file them.
        return Ok(Some(
            "owners answer asks; they do not file them".to_string(),
        ));
    };

    let audience_pubkey = PublicKey::from_hex(&parsed.audience_hex)
        .map_err(|_| "internal error: audience hex is not a valid pubkey".to_string())?;

    match signer_tier {
        AgentTier::Worker => {
            let audience_tier = agent_tier(tenant, state, &audience_pubkey).await?;
            if audience_tier != Some(AgentTier::Leader) {
                return Ok(Some(
                    "workers may only raise asks to their own leader".to_string(),
                ));
            }
        }
        AgentTier::Leader => {
            let audience_tier = agent_tier(tenant, state, &audience_pubkey).await?;
            if audience_tier != Some(AgentTier::Executive) {
                return Ok(Some(
                    "leaders may only escalate asks to the executive".to_string(),
                ));
            }
        }
        AgentTier::Executive => {
            let audience_is_owner = state
                .db
                .get_relay_member(tenant.community(), &parsed.audience_hex)
                .await
                .map_err(|error| format!("database error checking ask audience: {error}"))?
                .is_some_and(|member| member.role == "owner");
            if !audience_is_owner {
                return Ok(Some(
                    "the executive may only file asks to a community owner".to_string(),
                ));
            }
        }
    }

    Ok(None)
}

/// The community's default ask filing-to-deadline window, in seconds: the
/// `ask_window_secs` content field of its company profile head (kind
/// 30179), or [`DEFAULT_ASK_WINDOW_SECS`] when there is no company profile
/// yet, or the field is absent or malformed.
///
/// Never fails -- a missing or unreadable company default must not block
/// filing an ask.
async fn company_ask_window_secs(tenant: &TenantContext, state: &AppState) -> u64 {
    let rows = match state
        .db
        .query_events(&buzz_db::event::EventQuery {
            kinds: Some(vec![KIND_COMPANY_PROFILE as i32]),
            pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
            global_only: true,
            limit: Some(1),
            ..buzz_db::event::EventQuery::for_community(tenant.community())
        })
        .await
    {
        Ok(rows) => rows,
        Err(_) => return DEFAULT_ASK_WINDOW_SECS,
    };
    let Some(stored) = rows.into_iter().next() else {
        return DEFAULT_ASK_WINDOW_SECS;
    };
    let Ok(content) = serde_json::from_str::<serde_json::Value>(&stored.event.content) else {
        return DEFAULT_ASK_WINDOW_SECS;
    };
    content
        .get("ask_window_secs")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(DEFAULT_ASK_WINDOW_SECS)
}

/// Resolve an Ask (kind 44301): parse, load and re-parse the ask it
/// references, authorize the signer, enforce the answer policy, close the
/// row, and (when the ask carries an origin thread) wake the filer with a
/// relay-signed receipt.
async fn handle_resolution(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<AskBrokerOutcome, String> {
    // Canonical resolution receipts are only as trustworthy as the key that
    // signs them -- same reasoning as `company_broker::handle_company_action`'s
    // guard. Without a durable relay key every install shares the same
    // fallback dev key, and anyone could forge a "your ask was resolved"
    // wake-up receipt.
    if state.config.relay_private_key.is_none() {
        return Err(
            "ask resolution requires a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        );
    }

    let parsed = match parse_resolution(event) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(AskBrokerOutcome::Refused {
                message: error.to_string(),
            })
        }
    };

    let ask_event_bytes = hex::decode(&parsed.ask_event_hex)
        .map_err(|_| "internal error: a validated hex64 field failed to decode".to_string())?;

    let Some(stored_ask) = state
        .db
        .get_event_by_id(tenant.community(), &ask_event_bytes)
        .await
        .map_err(|error| format!("database error loading the referenced ask: {error}"))?
    else {
        return Ok(AskBrokerOutcome::Refused {
            message: "the referenced ask does not exist".to_string(),
        });
    };
    let Ok(ask) = parse_ask(&stored_ask.event) else {
        return Ok(AskBrokerOutcome::Refused {
            message: "the referenced event is not a valid ask".to_string(),
        });
    };

    if event.pubkey != state.relay_keypair.public_key() {
        let authorized =
            resolution_signer_authorized(tenant, state, &event.pubkey, &ask.audience_hex).await?;
        if !authorized {
            return Ok(AskBrokerOutcome::Refused {
                message: "only the ask's audience, an owner, or the relay may resolve it"
                    .to_string(),
            });
        }
    }

    // Parsing enforces shape (a missing `answer` becomes JSON null); the
    // broker enforces policy: decision and question asks need a real
    // answer, credential/blocker/stall asks do not carry one at all.
    if matches!(ask.ask_type, AskType::Decision | AskType::Question) && parsed.answer.is_null() {
        return Ok(AskBrokerOutcome::Refused {
            message: "decision and question asks require a non-null answer".to_string(),
        });
    }

    let resolved_by = event.pubkey.to_bytes();
    let flipped = state
        .db
        .resolve_ask(
            tenant.community(),
            &ask_event_bytes,
            event.id.as_bytes(),
            &resolved_by,
            parsed.default_executed,
        )
        .await
        .map_err(|error| format!("database error resolving ask: {error}"))?;
    if !flipped {
        return Ok(AskBrokerOutcome::Refused {
            message: "that ask is not open".to_string(),
        });
    }

    if let Some(origin_thread_hex) = &ask.origin_thread_hex {
        // C1 fix: `stored_ask.event.pubkey` is the signer of the ASK EVENT
        // itself, which for a promoted ask is the relay, not the original
        // filer -- `resolve_filer` prefers the `filer` tag in that case so
        // the wake-up receipt reaches the agent actually blocked.
        let blocked_agent = resolve_filer(state, &stored_ask.event, &ask)?;
        emit_ask_receipt(
            tenant,
            state,
            origin_thread_hex,
            &format!("Ask resolved: {}", ask.headline),
            blocked_agent,
            stored_ask.channel_id,
        )
        .await;
    }

    wake_superseded_prior_filer(tenant, state, &stored_ask.event, &ask).await;

    Ok(AskBrokerOutcome::Applied)
}

/// Whether `signer` may resolve an ask addressed to `audience_hex`: it must
/// either BE that audience, or -- when the audience itself holds the
/// community owner role -- be any current owner. An ask filed to "the
/// owner" is addressed to the role, not to one specific co-owner, so any
/// owner may answer it.
async fn resolution_signer_authorized(
    tenant: &TenantContext,
    state: &AppState,
    signer: &PublicKey,
    audience_hex: &str,
) -> Result<bool, String> {
    if signer.to_hex() == audience_hex {
        return Ok(true);
    }
    let audience_is_owner = state
        .db
        .get_relay_member(tenant.community(), audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !audience_is_owner {
        return Ok(false);
    }
    let signer_is_owner = state
        .db
        .get_relay_member(tenant.community(), &signer.to_hex())
        .await
        .map_err(|error| format!("database error checking resolution signer: {error}"))?
        .is_some_and(|member| member.role == "owner");
    Ok(signer_is_owner)
}

/// Withdraw an Ask (kind 44302): parse, require an Executive (or relay)
/// signer, close the row, and (when the ask carries an origin thread) wake
/// the filer with a relay-signed receipt.
async fn handle_withdrawal(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<AskBrokerOutcome, String> {
    // Same reasoning as `handle_resolution`'s guard: a withdrawal receipt is
    // a canonical "stand down" signal and must not be forgeable via the
    // shared fallback dev key.
    if state.config.relay_private_key.is_none() {
        return Err(
            "ask withdrawal requires a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        );
    }

    let parsed = match parse_withdrawal(event) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(AskBrokerOutcome::Refused {
                message: error.to_string(),
            })
        }
    };

    if event.pubkey != state.relay_keypair.public_key() {
        let signer_tier = agent_tier(tenant, state, &event.pubkey).await?;
        if signer_tier != Some(AgentTier::Executive) {
            return Ok(AskBrokerOutcome::Refused {
                message: "only the executive or the relay may withdraw an ask".to_string(),
            });
        }
    }

    let ask_event_bytes = hex::decode(&parsed.ask_event_hex)
        .map_err(|_| "internal error: a validated hex64 field failed to decode".to_string())?;

    let Some(stored_ask) = state
        .db
        .get_event_by_id(tenant.community(), &ask_event_bytes)
        .await
        .map_err(|error| format!("database error loading the referenced ask: {error}"))?
    else {
        return Ok(AskBrokerOutcome::Refused {
            message: "the referenced ask does not exist".to_string(),
        });
    };
    let Ok(ask) = parse_ask(&stored_ask.event) else {
        return Ok(AskBrokerOutcome::Refused {
            message: "the referenced event is not a valid ask".to_string(),
        });
    };

    let withdrawn = state
        .db
        .withdraw_ask(tenant.community(), &ask_event_bytes, event.id.as_bytes())
        .await
        .map_err(|error| format!("database error withdrawing ask: {error}"))?;
    if !withdrawn {
        return Ok(AskBrokerOutcome::Refused {
            message: "that ask is not open".to_string(),
        });
    }

    if let Some(origin_thread_hex) = &ask.origin_thread_hex {
        // C1 fix: see `handle_resolution`'s identical comment.
        let blocked_agent = resolve_filer(state, &stored_ask.event, &ask)?;
        emit_ask_receipt(
            tenant,
            state,
            origin_thread_hex,
            &format!("Ask withdrawn: {}", parsed.reason),
            blocked_agent,
            stored_ask.channel_id,
        )
        .await;
    }

    Ok(AskBrokerOutcome::Applied)
}

/// Post a relay-signed kind:9 receipt message into the channel
/// `origin_thread_hex`'s root event belongs to, tagged into that thread and
/// p-tagging `blocked_agent` so the agent whose work stalled on the ask
/// wakes back up where it stalled.
///
/// `ask_channel_id` is the ASK EVENT's own stored channel (not the
/// receipt's), used to authorize the target channel below.
///
/// Mirrors `handlers::side_effects::emit_system_message`'s shape (bare
/// insert + fan-out, tolerant of failure) rather than the full
/// `dispatch_persistent_event` path: by the time this runs the ask is
/// already durably resolved or withdrawn, and losing the wake notification
/// must not roll that back, so lookup/storage/fan-out failures here are
/// logged and swallowed rather than propagated.
///
/// `pub(crate)`: also used by `interrupt_runtime`'s default-execution path,
/// which wakes a filer exactly the way a human resolution would.
pub(crate) async fn emit_ask_receipt(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    origin_thread_hex: &str,
    content: &str,
    blocked_agent: PublicKey,
    ask_channel_id: Option<uuid::Uuid>,
) {
    let Ok(origin_thread_bytes) = hex::decode(origin_thread_hex) else {
        return;
    };
    let root = match state
        .db
        .get_event_by_id(tenant.community(), &origin_thread_bytes)
        .await
    {
        Ok(Some(root)) => root,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(%error, "ask receipt: failed to load origin thread root");
            return;
        }
    };
    let Some(channel_id) = root.channel_id else {
        return;
    };

    // The `e` tag naming this origin thread is filer-controlled: it can
    // name any event id in the community, not just one the ask actually
    // belongs to. Refuse silently (matching this function's best-effort
    // contract) unless the thread's channel is either the ask's own
    // channel, or one `blocked_agent` may legitimately post in (a member,
    // or an open channel) -- otherwise the relay would deliver
    // attacker-chosen text into a channel the filer cannot write to, under
    // the relay's own identity.
    let legitimate = ask_channel_id == Some(channel_id)
        || crate::handlers::ingest::check_channel_membership(
            tenant,
            state,
            channel_id,
            blocked_agent.as_bytes(),
            None,
        )
        .await
        .is_ok();
    if !legitimate {
        return;
    }

    let mut tags = Vec::new();
    if let Ok(tag) = Tag::parse(["h", &channel_id.to_string()]) {
        tags.push(tag);
    }
    if let Ok(tag) = Tag::parse(["e", origin_thread_hex, "", "root"]) {
        tags.push(tag);
    }
    if let Ok(tag) = Tag::parse(["p", &blocked_agent.to_hex()]) {
        tags.push(tag);
    }

    let event = match EventBuilder::new(Kind::Custom(KIND_STREAM_MESSAGE as u16), content)
        .tags(tags)
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(%error, "ask receipt: failed to sign receipt message");
            return;
        }
    };

    if let Err(error) = state
        .db
        .insert_event(tenant.community(), &event, Some(channel_id))
        .await
    {
        tracing::warn!(%error, "ask receipt: failed to store receipt message");
        return;
    }
    if let Err(error) = state
        .pubsub
        .publish_event(tenant, buzz_pubsub::EventTopic::Channel(channel_id), &event)
        .await
    {
        tracing::warn!(%error, "ask receipt: failed to fan out receipt message");
    }
}

/// Resolve every open owner-audience ask rooted at the thread `event`
/// replies into, when `event`'s signer currently holds the community's
/// `owner` role (spec: "You can still just answer in the thread").
///
/// An owner does not have to tap the Ask card: replying in the thread the
/// ask was raised from closes it exactly like a card resolution would,
/// with the owner's own message standing in as the resolution event. Left
/// unhandled, a thread reply that does not resolve its ask makes the open
/// queue lie -- it keeps showing an ask the owner believes they already
/// answered, which is the exact failure this whole system exists to
/// prevent.
///
/// Scope and gating, all `Ok(())` no-ops rather than errors:
/// - Only kind 9/40002 (plain stream messages) are considered.
/// - Only a signer whose relay-membership role is exactly `"owner"`
///   triggers this; an agent replying in the same thread never does.
/// - Only asks whose `audience_pubkey` itself resolves to a current owner
///   are eligible. An ask still climbing the altitude ladder (audience is
///   a leader or the executive -- see [`check_altitude`]) is untouched by
///   an owner's passing comment in a thread it also happens to occupy.
/// - The event must carry a NIP-10 thread root ([`extract_thread_root`]);
///   a root-level, non-reply message resolves nothing.
///
/// Every open owner-audience ask bound to the thread resolves, not just
/// the first match, and each gets the same relay-signed wake-up receipt a
/// card resolution would ([`emit_ask_receipt`], via
/// [`wake_filer_after_auto_resolve`]): the owner's own message is already
/// visible in the thread, but it is not guaranteed to p-tag the blocked
/// filer, and agents only respond to messages that mention them -- skipping
/// the receipt would leave a filer blocked forever unless the owner
/// happened to p-tag it by hand.
///
/// Called AFTER the owner's message is already durably stored (see
/// `handlers::ingest::ingest_event_inner`); the caller is responsible for
/// logging and swallowing whatever this returns rather than letting it
/// turn an already-accepted message into a rejection -- a missed
/// auto-resolve is recoverable (the owner can still tap the card, or reply
/// again), an owner whose message got bounced over interrupt-core
/// bookkeeping is not.
///
/// The two database reads before the loop below (the signer's own role,
/// and the set of candidate asks) still fail the whole call via `?` on
/// error -- there is nothing to iterate yet, so there is no partial pass to
/// protect. Once inside the loop, each candidate goes through
/// [`try_resolve_one_candidate`], which never propagates a failure back up
/// here: a thread can bind several open owner-audience asks, and a
/// database failure resolving one of them must not silently skip the
/// others in the same pass.
pub async fn try_auto_resolve_from_reply(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    event: &Event,
) -> Result<(), String> {
    if !matches!(
        event.kind.as_u16() as u32,
        KIND_STREAM_MESSAGE | KIND_STREAM_MESSAGE_V2
    ) {
        return Ok(());
    }

    let signer_hex = event.pubkey.to_hex();
    let signer_is_owner = state
        .db
        .get_relay_member(tenant.community(), &signer_hex)
        .await
        .map_err(|error| format!("database error checking owner role for auto-resolve: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !signer_is_owner {
        return Ok(());
    }

    let Some(thread_root) = extract_thread_root(event) else {
        return Ok(());
    };

    let candidates = state
        .db
        .find_open_asks_by_thread(tenant.community(), &thread_root)
        .await
        .map_err(|error| {
            format!("database error loading asks bound to this thread for auto-resolve: {error}")
        })?;
    if candidates.is_empty() {
        return Ok(());
    }

    let thread_root_hex = hex::encode(&thread_root);
    for row in candidates {
        if let Err(error) =
            try_resolve_one_candidate(tenant, state, &row, event, &thread_root_hex).await
        {
            // Isolated per candidate on purpose: a thread can bind several
            // open owner-audience asks (see
            // `owner_thread_reply_resolves_every_open_ask_bound_to_that_thread`
            // in `tests/ask_broker.rs`), and a database failure resolving
            // one of them must not silently skip the rest of the same
            // pass. Log and move on to the next row.
            tracing::warn!(
                ask_event_id = %hex::encode(&row.ask_event_id),
                %error,
                "auto-resolve: failed to resolve one candidate ask, continuing with any siblings"
            );
        }
    }

    Ok(())
}

/// Resolve a single candidate ask -- already known to be OPEN and rooted at
/// this thread -- if its `audience_pubkey` currently holds the owner role,
/// then wake its filer. A no-op `Ok(())` when the audience is not (or no
/// longer) an owner, or when `resolve_ask` reports it lost a race against a
/// card resolution/withdrawal that closed this exact ask a moment earlier.
///
/// `Err` only on a genuine database failure checking the audience or
/// resolving the row; see [`try_auto_resolve_from_reply`] for why the
/// caller must catch this per candidate rather than letting it abort the
/// whole pass.
async fn try_resolve_one_candidate(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    row: &AskRow,
    event: &Event,
    thread_root_hex: &str,
) -> Result<(), String> {
    let audience_hex = hex::encode(&row.audience_pubkey);
    let audience_is_owner = state
        .db
        .get_relay_member(tenant.community(), &audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience for auto-resolve: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if !audience_is_owner {
        // Still climbing the altitude ladder -- an owner's passing comment
        // in a thread it also occupies must not close it.
        return Ok(());
    }

    let flipped = state
        .db
        .resolve_ask(
            tenant.community(),
            &row.ask_event_id,
            event.id.as_bytes(),
            event.pubkey.as_bytes(),
            false,
        )
        .await
        .map_err(|error| format!("database error auto-resolving ask from reply: {error}"))?;
    if !flipped {
        // Lost a race against a card resolution/withdrawal that closed
        // this exact ask a moment earlier -- nothing left to wake.
        return Ok(());
    }

    wake_filer_after_auto_resolve(tenant, state, row, thread_root_hex).await;
    Ok(())
}

/// Best-effort wake-up for the filer of an ask [`try_auto_resolve_from_reply`]
/// just closed: loads the original ask event back to recover its headline
/// and channel, then posts the same relay-signed receipt a card resolution
/// would ([`emit_ask_receipt`]).
///
/// The ask is already resolved by the time this runs, so unlike
/// [`try_auto_resolve_from_reply`]'s own database calls, a failure here is
/// logged and swallowed rather than propagated: there is no partial-pass
/// state left to protect, only a filer that will learn about the
/// resolution some other way (its next status check) instead of being
/// woken immediately.
async fn wake_filer_after_auto_resolve(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    row: &AskRow,
    thread_root_hex: &str,
) {
    let filer = match PublicKey::from_slice(&row.filer_pubkey) {
        Ok(filer) => filer,
        Err(error) => {
            tracing::warn!(%error, "auto-resolve: stored filer pubkey is not valid, cannot wake it");
            return;
        }
    };

    let stored_ask = match state
        .db
        .get_event_by_id(tenant.community(), &row.ask_event_id)
        .await
    {
        Ok(stored_ask) => stored_ask,
        Err(error) => {
            tracing::warn!(%error, "auto-resolve: failed to load the ask event to wake its filer");
            return;
        }
    };
    let Some(stored_ask) = stored_ask else {
        return;
    };
    let headline = parse_ask(&stored_ask.event)
        .map(|ask| ask.headline)
        .unwrap_or_default();

    emit_ask_receipt(
        tenant,
        state,
        thread_root_hex,
        &format!("Ask resolved: {headline}"),
        filer,
        stored_ask.channel_id,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz"; // sadscan:disable np.postgres.1 -- local test-only credentials

    async fn setup_pool() -> PgPool {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| TEST_DB_URL.to_owned());
        let pool = PgPool::connect(&database_url)
            .await
            .expect("connect to test Postgres");
        buzz_db::migration::run_migrations(&pool)
            .await
            .expect("apply migrations");
        pool
    }

    /// I4 unit coverage: `is_unique_violation` must recognize the exact
    /// error shape a losing `insert_ask` call produces when it races
    /// another filer for the same `(community, initiative, need)`.
    ///
    /// Reproduced deterministically here via two SEQUENTIAL inserts (no
    /// concurrency needed to reproduce the error SHAPE -- Postgres raises
    /// the identical SQLSTATE 23505 whether the second writer arrives a
    /// microsecond or a millisecond after the first). The
    /// `handle_ask`-level integration test in `tests/ask_broker.rs`
    /// (`concurrent_asks_for_the_same_need_yield_one_applied_and_the_rest_duplicate`)
    /// covers genuinely racing filers reaching this classifier through the
    /// broker; this test covers the classifier itself in isolation.
    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn is_unique_violation_recognizes_a_real_dedupe_conflict() {
        let pool = setup_pool().await;
        let community_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_id)
            .bind(format!("ask-broker-unit-{}.example", community_id.simple()))
            .execute(&pool)
            .await
            .expect("insert test community");
        let community = buzz_core::CommunityId::from_uuid(community_id);

        let audience = [0x11_u8; 32];
        let filer = [0x22_u8; 32];
        let first_id = [0x33_u8; 32];
        let second_id = [0x44_u8; 32];

        buzz_db::asks::insert_ask(
            &pool,
            community,
            NewAskRow {
                ask_event_id: &first_id,
                ask_type: "decision",
                initiative_id: "init-1",
                need_key: "need-1",
                audience_pubkey: &audience,
                filer_pubkey: &filer,
                origin_thread: None,
                prior_ask: None,
                category: None,
                default_option: None,
                deadline_at: None,
            },
        )
        .await
        .expect("first insert must succeed");
        let conflict = buzz_db::asks::insert_ask(
            &pool,
            community,
            NewAskRow {
                ask_event_id: &second_id,
                ask_type: "decision",
                initiative_id: "init-1",
                need_key: "need-1",
                audience_pubkey: &audience,
                filer_pubkey: &filer,
                origin_thread: None,
                prior_ask: None,
                category: None,
                default_option: None,
                deadline_at: None,
            },
        )
        .await
        .expect_err("second open ask for the same need must be rejected");

        assert!(
            is_unique_violation(&conflict),
            "expected a unique-violation error, got: {conflict:?}"
        );
    }
}
