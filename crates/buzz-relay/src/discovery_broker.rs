//! Relay-owned broker for signed, private Discovery run commands.

use std::sync::Arc;

use buzz_core::{
    discovery::{
        DiscoveryAction, DiscoveryReceipt, DiscoveryRunProjection,
        DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION,
    },
    kind::{KIND_DISCOVERY_ACTION, KIND_DISCOVERY_RECEIPT},
    tenant::TenantContext,
};
use buzz_db::discovery::{DiscoveryCommandApply, DiscoveryCommandMutation};
use buzz_sdk::discovery::{build_discovery_receipt_for_version, parse_discovery_action};
use nostr::Event;

use crate::{handlers::event::dispatch_persistent_event, state::AppState};

/// Stable broker failure classes used by ingest to preserve HTTP/CLI semantics.
pub(crate) enum DiscoveryBrokerError {
    Invalid(String),
    Restricted(String),
    Conflict(String),
    Internal(String),
}

/// Successful result returned to event ingest.
pub(crate) enum DiscoveryBrokerOutcome {
    /// This signed action committed a command and receipt.
    Applied {
        /// Relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
        /// Safe point-in-time run projection.
        run: DiscoveryRunProjection,
    },
    /// This retry key was already committed by an earlier signed action.
    Duplicate {
        /// Original actor-signed action event ID.
        original_action_event_id: Vec<u8>,
        /// Original relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
        /// Current safe run projection.
        run: DiscoveryRunProjection,
    },
}

/// Whether this event belongs to the strict Discovery broker.
///
/// This is deliberately kind-only so malformed commands cannot fall through
/// to generic event persistence.
pub(crate) fn is_discovery_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_DISCOVERY_ACTION
}

fn accepts_new_start(fake_executor_enabled: bool, protocol_version: u16) -> bool {
    fake_executor_enabled || protocol_version == DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION
}

/// Apply one authenticated actor-signed Discovery command.
pub(crate) async fn handle_discovery_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<DiscoveryBrokerOutcome, DiscoveryBrokerError> {
    // Discovery receipts are commercial access-control records. The shared
    // development fallback key is not an acceptable authority for them.
    if state.config.relay_private_key.is_none() {
        return Err(DiscoveryBrokerError::Invalid(
            "Discovery actions require a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        ));
    }

    let parsed = parse_discovery_action(action_event)
        .map_err(|error| DiscoveryBrokerError::Invalid(error.to_string()))?;
    if parsed.relay_pubkey != state.relay_keypair.public_key() {
        return Err(DiscoveryBrokerError::Invalid(
            "Discovery action `p` tag must target this relay".into(),
        ));
    }

    let actor = action_event.pubkey.to_bytes();
    let operation = parsed.action.operation();
    let request_id = parsed.action.request_id();
    let idempotency_key = parsed.action.idempotency_key();
    let wire_version = parsed.wire_version;
    let mutation = match parsed.action {
        DiscoveryAction::Start(request) => {
            if !state.config.discovery.fake_executor_enabled
                && !state.config.discovery.external_worker_enabled
            {
                return Err(DiscoveryBrokerError::Invalid(
                    "Discovery execution is not enabled on this relay".into(),
                ));
            }
            if !accepts_new_start(
                state.config.discovery.fake_executor_enabled,
                request.protocol_version,
            ) {
                return Err(DiscoveryBrokerError::Conflict(
                    "desktop_upgrade_required".into(),
                ));
            }
            if request.protocol_version == DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION
                && state.discovery_gateway.get().is_none()
            {
                return Err(DiscoveryBrokerError::Conflict(
                    "desktop_upgrade_required".into(),
                ));
            }
            DiscoveryCommandMutation::Start {
                campaign_id: request.campaign_id,
                business_search: request.business_search,
                total_steps: if state.config.discovery.fake_executor_enabled {
                    state.config.discovery.fake_total_steps
                } else {
                    1
                },
                protocol_version: request.protocol_version,
                accepted_at: chrono::Utc::now(),
            }
        }
        DiscoveryAction::Status(request) => DiscoveryCommandMutation::Status {
            run_id: request.run_id,
        },
        DiscoveryAction::Cancel(request) => DiscoveryCommandMutation::Cancel {
            run_id: request.run_id,
        },
    };

    let relay_keys = state.relay_keypair.clone();
    let actor_pubkey = action_event.pubkey;
    let action_event_id = action_event.id;
    let applied = state
        .db
        .apply_discovery_command_once(
            tenant.community(),
            &actor,
            idempotency_key,
            mutation,
            action_event,
            move |run| {
                let receipt = DiscoveryReceipt {
                    operation,
                    request_id,
                    idempotency_key,
                    run: run.projection(),
                };
                build_discovery_receipt_for_version(
                    wire_version,
                    actor_pubkey,
                    action_event_id,
                    &receipt,
                )
                .map_err(|error| buzz_db::DbError::InvalidData(error.to_string()))?
                .sign_with_keys(&relay_keys)
                .map_err(|error| buzz_db::DbError::InvalidData(error.to_string()))
            },
        )
        .await
        .map_err(classify_db_error)?;

    match applied {
        DiscoveryCommandApply::Applied {
            action,
            receipt,
            run,
        } => {
            let actor_hex = action_event.pubkey.to_hex();
            let relay_hex = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &action,
                KIND_DISCOVERY_ACTION,
                &actor_hex,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &receipt,
                KIND_DISCOVERY_RECEIPT,
                &relay_hex,
                None,
            )
            .await;
            Ok(DiscoveryBrokerOutcome::Applied {
                receipt_event_id: receipt.event.id.as_bytes().to_vec(),
                run: run.projection(),
            })
        }
        DiscoveryCommandApply::Duplicate {
            original_action_event_id,
            receipt_event_id,
            run,
        } => Ok(DiscoveryBrokerOutcome::Duplicate {
            original_action_event_id,
            receipt_event_id,
            run: run.projection(),
        }),
    }
}

fn classify_db_error(error: buzz_db::DbError) -> DiscoveryBrokerError {
    match error {
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery entitlement is inactive" =>
        {
            DiscoveryBrokerError::Restricted("an active Discovery subscription is required".into())
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery requires relay membership" =>
        {
            DiscoveryBrokerError::Restricted("Discovery requires workspace membership".into())
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery agent capability is required" =>
        {
            DiscoveryBrokerError::Restricted(
                "this agent has not been granted the Discovery capability".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message.contains("idempotency key conflicts") =>
        {
            DiscoveryBrokerError::Conflict(
                "that idempotency key belongs to a different Discovery command".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message.contains("already has an active run") =>
        {
            DiscoveryBrokerError::Conflict(message)
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Campaign has no approved Credits budget" =>
        {
            DiscoveryBrokerError::Conflict("budget_unapproved".into())
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Campaign Credits budget is not active"
                || message == "budget_exhausted" =>
        {
            DiscoveryBrokerError::Conflict("budget_exhausted".into())
        }
        buzz_db::DbError::AccessDenied(message) if message == "balance_depleted" => {
            DiscoveryBrokerError::Conflict("balance_depleted".into())
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "campaign_search_already_executed" =>
        {
            DiscoveryBrokerError::Conflict("campaign_search_already_executed".into())
        }
        buzz_db::DbError::NotFound(message) if message.contains("campaign") => {
            DiscoveryBrokerError::Invalid("Discovery campaign not found".into())
        }
        buzz_db::DbError::NotFound(_) => {
            DiscoveryBrokerError::Invalid("Discovery run not found".into())
        }
        buzz_db::DbError::InvalidData(message)
            if message.contains("does not support this campaign's source plan") =>
        {
            DiscoveryBrokerError::Invalid(message)
        }
        other => DiscoveryBrokerError::Internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery::{DiscoveryBusinessSearchSpec, DiscoveryStartRequest};
    use buzz_sdk::discovery::build_discovery_start_action;
    use nostr::Keys;
    use uuid::Uuid;

    #[test]
    fn candidate_detection_is_kind_only() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = DiscoveryStartRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
            protocol_version: buzz_core::discovery::DISCOVERY_RELEASED_PROTOCOL_VERSION,
            business_search: Some(DiscoveryBusinessSearchSpec {
                query: "dentists".to_owned(),
                location: "Sandton, Johannesburg, South Africa".to_owned(),
                limit: 3,
                language: "en".to_owned(),
                region: Some("ZA".to_owned()),
            }),
        };
        let event = build_discovery_start_action(relay.public_key(), &request)
            .expect("valid builder")
            .sign_with_keys(&actor)
            .expect("valid signature");
        assert!(is_discovery_action_candidate(&event));
    }

    #[test]
    fn production_accepts_only_new_paid_starts_while_fake_runs_remain_compatible() {
        assert!(accepts_new_start(
            false,
            DISCOVERY_HOSTED_GATEWAY_PROTOCOL_VERSION
        ));
        assert!(!accepts_new_start(false, 2));
        assert!(!accepts_new_start(false, 1));
        assert!(accepts_new_start(true, 1));
    }
}
