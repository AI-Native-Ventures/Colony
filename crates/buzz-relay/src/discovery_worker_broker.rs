//! Relay broker for signed commands from trusted local Discovery workers.

use std::sync::Arc;

use buzz_core::{
    discovery_worker::{DiscoveryWorkerReceipt, DiscoveryWorkerReceiptOutcome},
    kind::{KIND_DISCOVERY_WORKER_ACTION, KIND_DISCOVERY_WORKER_RECEIPT},
    tenant::TenantContext,
};
use buzz_db::discovery::DiscoveryWorkerCommandApply;
use buzz_sdk::discovery_worker::{
    build_discovery_worker_receipt_for_version, parse_discovery_worker_action,
};
use chrono::Duration;
use nostr::Event;

use crate::{handlers::event::dispatch_persistent_event, state::AppState};

/// Stable worker-broker failure classes used by ingest.
pub(crate) enum DiscoveryWorkerBrokerError {
    Invalid(String),
    Restricted(String),
    Conflict(String),
    Internal(String),
}

/// Successful result returned to event ingest.
pub(crate) enum DiscoveryWorkerBrokerOutcome {
    /// This signed action committed its mutation and receipt.
    Applied {
        receipt_event_id: Vec<u8>,
        outcome: Box<DiscoveryWorkerReceiptOutcome>,
    },
    /// This retry key was already committed.
    Duplicate {
        original_action_event_id: Vec<u8>,
        receipt_event_id: Vec<u8>,
    },
}

/// Whether an event belongs to the strict local-worker broker.
pub(crate) fn is_discovery_worker_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_DISCOVERY_WORKER_ACTION
}

/// Apply one authenticated local-worker command.
pub(crate) async fn handle_discovery_worker_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<DiscoveryWorkerBrokerOutcome, DiscoveryWorkerBrokerError> {
    if !state.config.discovery.external_worker_enabled {
        return Err(DiscoveryWorkerBrokerError::Invalid(
            "local Discovery worker execution is not enabled on this relay".into(),
        ));
    }
    if state.config.relay_private_key.is_none() {
        return Err(DiscoveryWorkerBrokerError::Invalid(
            "Discovery worker actions require a durable relay signing key \
             (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        ));
    }

    let parsed = parse_discovery_worker_action(action_event)
        .map_err(|error| DiscoveryWorkerBrokerError::Invalid(error.to_string()))?;
    if parsed.relay_pubkey != state.relay_keypair.public_key() {
        return Err(DiscoveryWorkerBrokerError::Invalid(
            "Discovery worker action `p` tag must target this relay".into(),
        ));
    }

    let actor = action_event.pubkey.to_bytes();
    let operation = parsed.action.operation();
    let request_id = parsed.action.request_id();
    let idempotency_key = parsed.action.idempotency_key();
    let worker_id = parsed.action.worker_id();
    let actor_pubkey = action_event.pubkey;
    let action_event_id = action_event.id;
    let wire_version = parsed.wire_version;
    let relay_keys = state.relay_keypair.clone();
    let lease_duration = Duration::seconds(state.config.discovery.lease_seconds as i64);
    let applied = state
        .db
        .apply_discovery_worker_command_once(
            tenant.community(),
            &actor,
            &parsed.action,
            action_event,
            lease_duration,
            move |outcome| {
                let receipt = DiscoveryWorkerReceipt {
                    operation,
                    request_id,
                    idempotency_key,
                    worker_id,
                    outcome: outcome.clone(),
                };
                build_discovery_worker_receipt_for_version(
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
        DiscoveryWorkerCommandApply::Applied {
            action,
            receipt,
            outcome,
        } => {
            let actor_hex = action_event.pubkey.to_hex();
            let relay_hex = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &action,
                KIND_DISCOVERY_WORKER_ACTION,
                &actor_hex,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &receipt,
                KIND_DISCOVERY_WORKER_RECEIPT,
                &relay_hex,
                None,
            )
            .await;
            Ok(DiscoveryWorkerBrokerOutcome::Applied {
                receipt_event_id: receipt.event.id.as_bytes().to_vec(),
                outcome,
            })
        }
        DiscoveryWorkerCommandApply::Duplicate {
            original_action_event_id,
            receipt_event_id,
        } => Ok(DiscoveryWorkerBrokerOutcome::Duplicate {
            original_action_event_id,
            receipt_event_id,
        }),
    }
}

fn classify_db_error(error: buzz_db::DbError) -> DiscoveryWorkerBrokerError {
    match error {
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery entitlement is inactive" =>
        {
            DiscoveryWorkerBrokerError::Restricted(
                "an active Discovery subscription is required".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery requires relay membership" =>
        {
            DiscoveryWorkerBrokerError::Restricted("Discovery requires workspace membership".into())
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery agent capability is required" =>
        {
            DiscoveryWorkerBrokerError::Restricted(
                "this agent has not been granted the Discovery capability".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message) if message.contains("conflict") => {
            DiscoveryWorkerBrokerError::Conflict(message)
        }
        buzz_db::DbError::InvalidData(message)
            if message.contains("checkpoints must be committed in sequence") =>
        {
            DiscoveryWorkerBrokerError::Conflict(message)
        }
        buzz_db::DbError::InvalidData(message)
            if message
                .contains("observations require the matching submitted provider checkpoint") =>
        {
            DiscoveryWorkerBrokerError::Invalid(message)
        }
        buzz_db::DbError::InvalidData(message)
            if message.contains("observation provider is not in the run plan") =>
        {
            DiscoveryWorkerBrokerError::Invalid(message)
        }
        buzz_db::DbError::NotFound(_) => {
            DiscoveryWorkerBrokerError::Invalid("Discovery run not found".into())
        }
        other => DiscoveryWorkerBrokerError::Internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery_worker::{DiscoveryProvider, DiscoveryWorkerClaimRequest};
    use buzz_sdk::discovery_worker::build_discovery_worker_claim_action;
    use nostr::Keys;
    use uuid::Uuid;

    #[test]
    fn candidate_detection_is_kind_only() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = DiscoveryWorkerClaimRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            worker_id: Uuid::new_v4(),
            available_providers: vec![DiscoveryProvider::Outscraper],
        };
        let event = build_discovery_worker_claim_action(relay.public_key(), &request)
            .expect("valid builder")
            .sign_with_keys(&actor)
            .expect("valid signature");
        assert!(is_discovery_worker_action_candidate(&event));
    }
}
