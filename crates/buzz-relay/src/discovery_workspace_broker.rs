//! Relay-owned broker for private Discovery campaign and Lead operations.

use std::sync::Arc;

use buzz_core::{
    discovery_workspace::{DiscoveryWorkspaceReceipt, DiscoveryWorkspaceResult},
    kind::{KIND_DISCOVERY_WORKSPACE_ACTION, KIND_DISCOVERY_WORKSPACE_RECEIPT},
    tenant::TenantContext,
};
use buzz_db::discovery_workspace::DiscoveryWorkspaceCommandApply;
use buzz_sdk::discovery_workspace::{
    build_discovery_workspace_receipt_for_version, parse_discovery_workspace_action,
};
use nostr::Event;

use crate::{handlers::event::dispatch_persistent_event, state::AppState};

/// Stable broker failure classes used by ingest.
pub(crate) enum DiscoveryWorkspaceBrokerError {
    Invalid(String),
    Restricted(String),
    Conflict(String),
    Internal(String),
}

/// Successful private workspace result returned to event ingest.
pub(crate) enum DiscoveryWorkspaceBrokerOutcome {
    /// This action and its relay receipt committed.
    Applied {
        /// Relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
        /// Strict private result.
        result: Box<DiscoveryWorkspaceResult>,
    },
    /// This retry key was already committed.
    Duplicate {
        /// Original actor-signed action event ID.
        original_action_event_id: Vec<u8>,
        /// Original relay-signed receipt event ID.
        receipt_event_id: Vec<u8>,
    },
}

/// Whether an event belongs to the strict workspace broker.
pub(crate) fn is_discovery_workspace_action_candidate(event: &Event) -> bool {
    event.kind.as_u16() as u32 == KIND_DISCOVERY_WORKSPACE_ACTION
}

/// Apply one authenticated actor-signed campaign/Lead operation.
pub(crate) async fn handle_discovery_workspace_action(
    tenant: &TenantContext,
    state: &Arc<AppState>,
    action_event: &Event,
) -> Result<DiscoveryWorkspaceBrokerOutcome, DiscoveryWorkspaceBrokerError> {
    if state.config.relay_private_key.is_none() {
        return Err(DiscoveryWorkspaceBrokerError::Invalid(
            "Discovery actions require a durable relay signing key (set BUZZ_RELAY_PRIVATE_KEY)"
                .into(),
        ));
    }
    let parsed = parse_discovery_workspace_action(action_event)
        .map_err(|error| DiscoveryWorkspaceBrokerError::Invalid(error.to_string()))?;
    if parsed.relay_pubkey != state.relay_keypair.public_key() {
        return Err(DiscoveryWorkspaceBrokerError::Invalid(
            "Discovery workspace action `p` tag must target this relay".into(),
        ));
    }
    let actor = action_event.pubkey.to_bytes();
    let operation = parsed.request.payload.operation();
    let request_id = parsed.request.request_id;
    let idempotency_key = parsed.request.idempotency_key;
    let actor_pubkey = action_event.pubkey;
    let action_event_id = action_event.id;
    let wire_version = parsed.wire_version;
    let relay_keys = state.relay_keypair.clone();
    let applied = state
        .db
        .apply_discovery_workspace_command_once(
            tenant.community(),
            &actor,
            &parsed.request,
            action_event,
            move |result| {
                let receipt = DiscoveryWorkspaceReceipt {
                    operation,
                    request_id,
                    idempotency_key,
                    result: result.clone(),
                };
                build_discovery_workspace_receipt_for_version(
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
        DiscoveryWorkspaceCommandApply::Applied {
            action,
            receipt,
            result,
        } => {
            let actor_hex = action_event.pubkey.to_hex();
            let relay_hex = state.relay_keypair.public_key().to_hex();
            dispatch_persistent_event(
                tenant,
                state,
                &action,
                KIND_DISCOVERY_WORKSPACE_ACTION,
                &actor_hex,
                None,
            )
            .await;
            dispatch_persistent_event(
                tenant,
                state,
                &receipt,
                KIND_DISCOVERY_WORKSPACE_RECEIPT,
                &relay_hex,
                None,
            )
            .await;
            Ok(DiscoveryWorkspaceBrokerOutcome::Applied {
                receipt_event_id: receipt.event.id.as_bytes().to_vec(),
                result,
            })
        }
        DiscoveryWorkspaceCommandApply::Duplicate {
            original_action_event_id,
            receipt_event_id,
        } => Ok(DiscoveryWorkspaceBrokerOutcome::Duplicate {
            original_action_event_id,
            receipt_event_id,
        }),
    }
}

fn classify_db_error(error: buzz_db::DbError) -> DiscoveryWorkspaceBrokerError {
    match error {
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery entitlement is inactive" =>
        {
            DiscoveryWorkspaceBrokerError::Restricted(
                "an active Discovery subscription is required".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery requires relay membership" =>
        {
            DiscoveryWorkspaceBrokerError::Restricted(
                "Discovery requires workspace membership".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery agent capability is required" =>
        {
            DiscoveryWorkspaceBrokerError::Restricted(
                "this agent has not been granted the Discovery capability".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message.contains("idempotency key conflicts") =>
        {
            DiscoveryWorkspaceBrokerError::Conflict(
                "that idempotency key belongs to a different Discovery workspace command".into(),
            )
        }
        buzz_db::DbError::AccessDenied(message)
            if message == "Discovery campaign identifier already exists" =>
        {
            DiscoveryWorkspaceBrokerError::Conflict(message)
        }
        buzz_db::DbError::NotFound(_) => {
            DiscoveryWorkspaceBrokerError::Invalid("Discovery campaign not found".into())
        }
        other => DiscoveryWorkspaceBrokerError::Internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery_workspace::{
        DiscoveryCampaignListRequest, DiscoveryWorkspaceActionPayload, DiscoveryWorkspaceRequest,
    };
    use buzz_sdk::discovery_workspace::build_discovery_workspace_action;
    use nostr::Keys;
    use uuid::Uuid;

    #[test]
    fn candidate_detection_is_kind_only() {
        let relay = Keys::generate();
        let request = DiscoveryWorkspaceRequest {
            request_id: Uuid::new_v4(),
            idempotency_key: Uuid::new_v4(),
            payload: DiscoveryWorkspaceActionPayload::ListCampaigns {
                request: DiscoveryCampaignListRequest {
                    industry_id: None,
                    vertical_id: None,
                    offset: 0,
                    limit: 25,
                },
            },
        };
        let event = build_discovery_workspace_action(relay.public_key(), &request)
            .expect("build action")
            .sign_with_keys(&Keys::generate())
            .expect("sign action");
        assert!(is_discovery_workspace_action_candidate(&event));
    }
}
