//! Colony interrupt-core: relay-signed ask-state heads (kind 30200).
//!
//! One parameterized-replaceable head per Ask (`d` = the ask event id),
//! signed by the relay, carrying the `asks` projection's own `deadline_at`
//! plus a named expiry outcome. This is the read path for the deadline:
//! nothing outside the relay can compute it (the window comes from the
//! ask's content or the company profile, then gets clamped), so a client
//! that recomputed it would drift from the real deadline -- and a countdown
//! that disagrees with the sweep is worse than none.
//!
//! Precedent: the employee head (kind 30190) is relay-signed for exactly
//! this reason, and like that head every publication here is best-effort.
//! The durable record is the `asks` row; a lost head heals on the next
//! transition of the same ask (re-arm, resolution, promotion), which is why
//! failures are logged rather than propagated into paths that have already
//! committed their state.
//!
//! ## When heads are published
//!
//! - **Filing**: `ask_broker::handle_ask`, after the projection row commits,
//!   with the freshly computed `deadline_at` and a predicted expiry outcome.
//! - **Re-arm**: `interrupt_runtime::redeadline`, after
//!   `extend_ask_deadline` commits, with the fresh deadline and a
//!   `rearmed_at` marker distinguishing an actively re-armed timer from a
//!   stale one.
//! - **Outcome change**: default execution, human or auto-resolve
//!   resolution, withdrawal, ghost-row closure, and promotion each close
//!   the head with a terminal status so no client keeps counting down on an
//!   answered ask. A promoted original names its successor event id; the
//!   successor's own open head arrives through the ordinary filing path.
//!
//! Known eventual consistency: if a promotion's successor fails to file and
//! [`interrupt_runtime`]'s compensation reopens the row, the head briefly
//! reads `promoted` while the row is open again. The next sweep tick
//! re-processes the reopened row (its deadline has passed) and republishes;
//! no separate compensation is written here.
//!
//! The expiry outcome is a PREDICTION computed from current community state
//! at publication time (owner role, tier, unique executive/owner). The sweep
//! re-decides from live data at expiry; where reality differs (an executive
//! was hired or removed since filing), the re-arm publication carries the
//! corrected outcome.

use std::sync::Arc;

use buzz_core::interrupt::{AgentTier, AskExpiryAction, AskPromotionTarget, AskStateStatus};
use buzz_core::kind::KIND_ASK_STATE;
use buzz_core::tenant::TenantContext;
use buzz_core::CommunityId;
use buzz_db::asks::AskRow;
use nostr::{EventBuilder, Kind, PublicKey, Tag};

use crate::handlers::event::dispatch_persistent_event;
use crate::interrupt_gate::agent_tier;
use crate::interrupt_runtime::{find_unique_executive, find_unique_owner};
use crate::state::AppState;

/// The predicted expiry outcome carried in an open head's content, as JSON
/// field values (`on_expiry`, plus `default_option`/`promotes_to`).
pub(crate) enum ExpiryOutcome {
    /// A stated default applies when the deadline passes.
    DefaultExecutes {
        /// The option label the sweep will execute.
        option: String,
    },
    /// The ask auto-promotes one rung up the altitude ladder.
    Promotes(AskPromotionTarget),
    /// Nowhere to go: the sweep re-arms the ask instead.
    Rearm,
}

impl ExpiryOutcome {
    fn action(&self) -> AskExpiryAction {
        match self {
            Self::DefaultExecutes { .. } => AskExpiryAction::DefaultExecutes,
            Self::Promotes(_) => AskExpiryAction::Promotes,
            Self::Rearm => AskExpiryAction::Rearms,
        }
    }

    /// The content fields this outcome contributes, mirroring exactly what
    /// `buzz_core::interrupt::parse_ask_state` validates.
    fn content_fields(&self) -> serde_json::Value {
        let mut value = serde_json::json!({ "on_expiry": self.action().as_str() });
        match self {
            Self::DefaultExecutes { option } => {
                value["default_option"] = serde_json::json!(option);
            }
            Self::Promotes(target) => {
                value["promotes_to"] = serde_json::json!(target.as_str());
            }
            Self::Rearm => {}
        }
        value
    }
}

/// What will happen when this ask's deadline passes, decided the same way
/// [`crate::interrupt_runtime::process_due_ask`] will decide it at expiry:
///
/// 1. An ask addressed to a CURRENT owner that carries a stated
///    `default_option` default-executes. (The sweep does not restrict this
///    to decision/question asks -- any non-stall ask may state a default.)
/// 2. Otherwise, a leader-audience ask climbs to the community's unique
///    executive and an executive-audience ask climbs to its unique human
///    owner -- but only while that next rung resolves unambiguously.
/// 3. Everything else (already at the top without a default, zero/multiple
///    executives or owners, an audience whose tier dissolved) is re-armed
///    with a fresh deadline rather than answered or promoted.
async fn predict_expiry_outcome(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    audience_hex: &str,
    default_option: Option<&str>,
) -> Result<ExpiryOutcome, String> {
    let audience_is_owner = state
        .db
        .get_relay_member(tenant.community(), audience_hex)
        .await
        .map_err(|error| format!("database error checking ask audience: {error}"))?
        .is_some_and(|member| member.role == "owner");
    if audience_is_owner {
        return Ok(match default_option {
            Some(option) => ExpiryOutcome::DefaultExecutes {
                option: option.to_owned(),
            },
            None => ExpiryOutcome::Rearm,
        });
    }

    let audience = PublicKey::from_hex(audience_hex)
        .map_err(|_| "internal error: audience hex is not a valid pubkey".to_string())?;
    match agent_tier(tenant, state, &audience).await? {
        Some(AgentTier::Leader) => {
            if find_unique_executive(tenant, state).await?.is_some() {
                Ok(ExpiryOutcome::Promotes(AskPromotionTarget::Executive))
            } else {
                // Zero or multiple executives: the sweep would decline and
                // re-deadline, so say so now.
                Ok(ExpiryOutcome::Rearm)
            }
        }
        Some(AgentTier::Executive) => {
            if find_unique_owner(tenant, state).await?.is_some() {
                Ok(ExpiryOutcome::Promotes(AskPromotionTarget::Owner))
            } else {
                Ok(ExpiryOutcome::Rearm)
            }
        }
        Some(AgentTier::Worker) | None => Ok(ExpiryOutcome::Rearm),
    }
}

/// Merge an outcome's content fields into a head's content object. Both
/// sides are relay-built, so a non-object here is an internal bug; leaving
/// the content unmerged (and the head parse-rejectable) beats panicking in
/// a best-effort path.
fn merge_content_fields(content: &mut serde_json::Value, fields: serde_json::Value) {
    if let (Some(map), Some(extra)) = (content.as_object_mut(), fields.as_object()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
}

/// Sign, store (NIP-33 latest-wins), and fan out one ask-state head.
///
/// Best-effort throughout, mirroring `employee_broker`'s head writer: the
/// caller has already committed the state this head projects. `created_at`
/// is forced strictly past the current live revision because stale-write
/// protection rejects a same-second replacement whose random event id sorts
/// higher -- a filing followed by a re-arm within the same second must not
/// strand the older head.
async fn sign_store_and_fan_out_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    ask_event_id_hex: &str,
    content: serde_json::Value,
    what: &str,
) {
    let mut ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let query = buzz_db::event::EventQuery {
        kinds: Some(vec![KIND_ASK_STATE as i32]),
        pubkey: Some(state.relay_keypair.public_key().to_bytes().to_vec()),
        d_tag: Some(ask_event_id_hex.to_string()),
        limit: Some(1),
        ..buzz_db::event::EventQuery::for_community(tenant.community())
    };
    if let Ok(existing) = state.db.query_events(&query).await {
        if let Some(previous) = existing.first() {
            ts = ts.max(previous.event.created_at.as_secs() + 1);
        }
    }

    let event = match EventBuilder::new(Kind::Custom(KIND_ASK_STATE as u16), content.to_string())
        .tags(vec![match Tag::parse(["d", ask_event_id_hex]) {
            Ok(tag) => tag,
            Err(error) => {
                tracing::warn!(%error, "ask-state head: failed to build `d` tag");
                return;
            }
        }])
        .custom_created_at(nostr::Timestamp::from(ts))
        .sign_with_keys(&state.relay_keypair)
    {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(%error, "ask-state head: failed to sign ({what})");
            return;
        }
    };

    let (stored, outcome) = match state
        .db
        .replace_parameterized_event(tenant.community(), &event, ask_event_id_hex, None)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(
                ask_event_id = %ask_event_id_hex,
                %error,
                "ask-state head: failed to store ({what})"
            );
            return;
        }
    };
    if !outcome.was_inserted() {
        // Lost latest-wins against a newer revision of the same head --
        // possible only under concurrent transitions of one ask. The winner
        // is at least as new as what this call would have written.
        tracing::warn!(
            ask_event_id = %ask_event_id_hex,
            "ask-state head: superseded by a newer revision before fan-out ({what})"
        );
        return;
    }
    dispatch_persistent_event(
        tenant,
        state,
        &stored,
        KIND_ASK_STATE,
        &state.relay_keypair.public_key().to_hex(),
        None,
    )
    .await;
}

/// Publish the OPEN head for a freshly filed ask: the broker's computed
/// `deadline_at` verbatim, plus the predicted expiry outcome. Called after
/// the `asks` row commits; never blocks or fails the filing itself.
pub(crate) async fn publish_head_for_new_ask(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    ask_event_id: &[u8],
    deadline_at: i64,
    audience_hex: &str,
    default_option: Option<&str>,
) {
    let outcome = match predict_expiry_outcome(tenant, state, audience_hex, default_option).await {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::warn!(
                ask_event_id = %hex::encode(ask_event_id),
                %error,
                "ask-state head: could not predict the expiry outcome; publishing without one \
                 is worse than no head"
            );
            return;
        }
    };

    let mut content = serde_json::json!({
        "status": AskStateStatus::Open.as_str(),
        "deadline_at": deadline_at,
    });
    merge_content_fields(&mut content, outcome.content_fields());
    sign_store_and_fan_out_head(tenant, state, &hex::encode(ask_event_id), content, "filing").await;
}

/// Republish the OPEN head after the sweep re-armed a due ask: fresh
/// deadline, `rearmed_at` marker, and a re-predicted outcome (community
/// state may have changed since filing -- e.g. an executive was hired).
///
/// Takes a bare [`CommunityId`] because `redeadline` may run for a
/// community whose host can no longer be resolved; the host is looked up
/// here, mirroring `process_due_ask`. Best-effort.
pub(crate) async fn publish_rearmed_head(
    state: &Arc<AppState>,
    community: CommunityId,
    row: &AskRow,
    new_deadline_at: i64,
    rearmed_at_secs: i64,
) {
    let ask_event_id_hex = hex::encode(&row.ask_event_id);
    let Some(host) = state
        .db
        .lookup_community_host(community)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(
                %error,
                ask_event_id = %ask_event_id_hex,
                "ask-state head: failed to resolve the community host for re-arm"
            );
            None
        })
    else {
        return;
    };
    let tenant = TenantContext::resolved(community, host);

    let audience_hex = hex::encode(&row.audience_pubkey);
    let outcome =
        match predict_expiry_outcome(&tenant, state, &audience_hex, row.default_option.as_deref())
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::warn!(
                    ask_event_id = %ask_event_id_hex,
                    %error,
                    "ask-state head: could not re-predict the expiry outcome on re-arm"
                );
                return;
            }
        };

    let mut content = serde_json::json!({
        "status": AskStateStatus::Open.as_str(),
        "deadline_at": new_deadline_at,
        "rearmed_at": rearmed_at_secs,
    });
    merge_content_fields(&mut content, outcome.content_fields());
    sign_store_and_fan_out_head(&tenant, state, &ask_event_id_hex, content, "re-arm").await;
}

/// How an ask closed, shaping a terminal head.
pub(crate) enum AskClosure {
    /// A resolution answered the ask (human or auto-resolve).
    Resolved {
        /// Whether that resolution executed the stated default.
        default_executed: bool,
        /// The option the default execution applied, so a client can say
        /// what happened without re-reading the ask's own content. `None`
        /// for human resolutions.
        default_option: Option<String>,
    },
    /// The executive (or the relay, on a ghost row) withdrew the ask.
    Withdrawn,
    /// The interrupt sweep promoted the ask; `successor` is the successor
    /// ask's event id, where the live countdown continues.
    Promoted {
        /// The successor ask's raw event id.
        successor: Vec<u8>,
    },
}

/// Publish a TERMINAL head after an ask's outcome changed, so no client
/// keeps counting down toward a deadline that can no longer fire. Best-effort.
pub(crate) async fn publish_closed_head(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    ask_event_id: &[u8],
    closure: &AskClosure,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut content = serde_json::json!({
        "status": match closure {
            AskClosure::Resolved { .. } => AskStateStatus::Resolved,
            AskClosure::Withdrawn => AskStateStatus::Withdrawn,
            AskClosure::Promoted { .. } => AskStateStatus::Promoted,
        }
        .as_str(),
        "closed_at": now,
    });
    match closure {
        AskClosure::Resolved {
            default_executed,
            default_option,
        } => {
            content["default_executed"] = serde_json::json!(default_executed);
            if let Some(option) = default_option {
                content["default_option"] = serde_json::json!(option);
            }
        }
        AskClosure::Withdrawn => {}
        AskClosure::Promoted { successor } => {
            content["successor_event_id"] = serde_json::json!(hex::encode(successor));
        }
    }
    sign_store_and_fan_out_head(
        tenant,
        state,
        &hex::encode(ask_event_id),
        content,
        "closure",
    )
    .await;
}
