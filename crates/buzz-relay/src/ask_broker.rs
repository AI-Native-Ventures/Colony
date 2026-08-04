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

use std::sync::Arc;

use buzz_core::interrupt::{
    parse_ask, parse_resolution, parse_withdrawal, AgentTier, AskType, ParsedAsk,
};
use buzz_core::kind::{
    KIND_ASK, KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL, KIND_COMPANY_PROFILE, KIND_STREAM_MESSAGE,
};
use buzz_core::tenant::TenantContext;
use buzz_db::asks::NewAskRow;
use nostr::{Event, EventBuilder, Kind, PublicKey, Tag};

use crate::interrupt_gate::agent_tier;
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
        let original_ask_event_id: [u8; 32] = existing
            .ask_event_id
            .as_slice()
            .try_into()
            .map_err(|_| "internal error: stored ask event id is not 32 bytes".to_string())?;
        return Ok(AskBrokerOutcome::Duplicate {
            original_ask_event_id,
        });
    }

    let window_secs = match parsed.default_window_secs {
        Some(secs) => secs,
        None => company_ask_window_secs(tenant, state).await,
    };
    let deadline_at = event.created_at.as_secs() as i64 + window_secs as i64;

    let audience_bytes = PublicKey::from_hex(&parsed.audience_hex)
        .map_err(|_| "internal error: audience hex is not a valid pubkey".to_string())?
        .to_bytes()
        .to_vec();
    let origin_thread_bytes = decode_hex64(parsed.origin_thread_hex.as_deref())?;
    let prior_ask_bytes = decode_hex64(parsed.prior_ask_hex.as_deref())?;

    state
        .db
        .insert_ask(
            tenant.community(),
            NewAskRow {
                ask_event_id: event.id.as_bytes(),
                ask_type: parsed.ask_type.as_str(),
                initiative_id: &parsed.initiative_id,
                need_key: &parsed.need_key,
                audience_pubkey: &audience_bytes,
                filer_pubkey: event.pubkey.as_bytes(),
                origin_thread: origin_thread_bytes.as_deref(),
                prior_ask: prior_ask_bytes.as_deref(),
                category: parsed.category.as_deref(),
                default_option: parsed.default_option.as_deref(),
                deadline_at: Some(deadline_at),
            },
        )
        .await
        .map_err(|error| format!("database error filing ask: {error}"))?;

    Ok(AskBrokerOutcome::Applied)
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
        emit_ask_receipt(
            tenant,
            state,
            origin_thread_hex,
            &format!("Ask resolved: {}", ask.headline),
            stored_ask.event.pubkey,
            stored_ask.channel_id,
        )
        .await;
    }

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
        emit_ask_receipt(
            tenant,
            state,
            origin_thread_hex,
            &format!("Ask withdrawn: {}", parsed.reason),
            stored_ask.event.pubkey,
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
async fn emit_ask_receipt(
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
