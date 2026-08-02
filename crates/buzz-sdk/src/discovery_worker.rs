//! Strict signed Nostr envelopes for trusted local Discovery workers.

use buzz_core::{
    discovery::{DiscoveryRunProjection, DiscoveryRunState},
    discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryWorkerAction, DiscoveryWorkerCheckpoint,
        DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest, DiscoveryWorkerLeaseRequest,
        DiscoveryWorkerOperation, DiscoveryWorkerReceipt, DiscoveryWorkerReceiptOutcome,
    },
    kind::{KIND_DISCOVERY_WORKER_ACTION, KIND_DISCOVERY_WORKER_RECEIPT},
};
use nostr::{Event, EventBuilder, EventId, Kind, PublicKey};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::discovery::{
    canonical_content, parse_canonical_content, parse_pubkey, parse_uuid, require_exact_tag_names,
    require_kind, required_scalar_tag, required_tuple_tag, scalar_tag, tuple_tag, validate_uuid,
    DiscoverySdkError,
};

const ACTION_SCHEMA: &str = "colony.discovery-worker-action/v1";
const RECEIPT_SCHEMA: &str = "colony.discovery-worker-receipt/v1";
const MAX_PROVIDER_REQUEST_ID_LEN: usize = 128;

/// Strict worker action together with the relay named by its `p` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkerAction {
    /// Relay public key addressed by the worker.
    pub relay_pubkey: PublicKey,
    /// Validated operation-specific payload.
    pub action: DiscoveryWorkerAction,
}

/// Strict worker receipt together with its private routing references.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDiscoveryWorkerReceipt {
    /// Exact receipt event ID.
    pub event_id: EventId,
    /// Worker actor named by the receipt's `p` tag.
    pub actor_pubkey: PublicKey,
    /// Exact worker action processed by the relay.
    pub action_event_id: EventId,
    /// Validated private receipt content.
    pub receipt: DiscoveryWorkerReceipt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct DiscoveryWorkerActionContent {
    schema: String,
    operation: DiscoveryWorkerOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    worker_id: Uuid,
    run_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    checkpoint: Option<DiscoveryWorkerCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct DiscoveryWorkerReceiptContent {
    schema: String,
    #[serde(flatten)]
    receipt: DiscoveryWorkerReceipt,
}

/// Build a member-signable claim action.
pub fn build_discovery_worker_claim_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerClaimRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_uuid(request.request_id, "discovery worker action")?;
    validate_uuid(request.idempotency_key, "discovery worker action")?;
    validate_uuid(request.worker_id, "discovery worker action")?;
    build_action(
        relay_pubkey,
        DiscoveryWorkerOperation::Claim,
        request.request_id,
        request.idempotency_key,
        request.worker_id,
        None,
        None,
        None,
    )
}

/// Build a member-signable heartbeat action.
pub fn build_discovery_worker_heartbeat_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerLeaseRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    build_lease_action(relay_pubkey, DiscoveryWorkerOperation::Heartbeat, request)
}

/// Build a member-signable checkpoint action.
pub fn build_discovery_worker_checkpoint_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerCheckpointRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_lease_request(&request.lease)?;
    validate_checkpoint(&request.checkpoint)?;
    build_action(
        relay_pubkey,
        DiscoveryWorkerOperation::Checkpoint,
        request.lease.request_id,
        request.lease.idempotency_key,
        request.lease.worker_id,
        Some(request.lease.run_id),
        Some(request.lease.lease_id),
        Some(request.checkpoint.clone()),
    )
}

/// Build a member-signable completion action.
pub fn build_discovery_worker_complete_action(
    relay_pubkey: PublicKey,
    request: &DiscoveryWorkerLeaseRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    build_lease_action(relay_pubkey, DiscoveryWorkerOperation::Complete, request)
}

fn build_lease_action(
    relay_pubkey: PublicKey,
    operation: DiscoveryWorkerOperation,
    request: &DiscoveryWorkerLeaseRequest,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_lease_request(request)?;
    build_action(
        relay_pubkey,
        operation,
        request.request_id,
        request.idempotency_key,
        request.worker_id,
        Some(request.run_id),
        Some(request.lease_id),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_action(
    relay_pubkey: PublicKey,
    operation: DiscoveryWorkerOperation,
    request_id: Uuid,
    idempotency_key: Uuid,
    worker_id: Uuid,
    run_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    checkpoint: Option<DiscoveryWorkerCheckpoint>,
) -> Result<EventBuilder, DiscoverySdkError> {
    let relay_text = relay_pubkey.to_hex();
    let worker_text = worker_id.to_string();
    let request_text = request_id.to_string();
    let idempotency_text = idempotency_key.to_string();
    let operation_text = operation_tag(operation);
    let content = DiscoveryWorkerActionContent {
        schema: ACTION_SCHEMA.to_owned(),
        operation,
        request_id,
        idempotency_key,
        worker_id,
        run_id,
        lease_id,
        checkpoint,
    };
    let mut tags = vec![
        scalar_tag("p", &relay_text)?,
        scalar_tag("worker", &worker_text)?,
    ];
    if let (Some(run_id), Some(lease_id)) = (run_id, lease_id) {
        tags.push(scalar_tag("run", &run_id.to_string())?);
        tags.push(scalar_tag("lease", &lease_id.to_string())?);
    }
    tags.push(tuple_tag(&[
        "discovery-worker-action",
        "1",
        operation_text,
        &request_text,
        &idempotency_text,
    ])?);
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_WORKER_ACTION as u16),
        canonical_content(&content, "discovery worker action")?,
    )
    .tags(tags))
}

/// Parse an exact local-worker action envelope.
pub fn parse_discovery_worker_action(
    event: &Event,
) -> Result<ParsedDiscoveryWorkerAction, DiscoverySdkError> {
    require_kind(event, KIND_DISCOVERY_WORKER_ACTION)?;
    let tuple = required_tuple_tag(event, "discovery-worker-action", 5)?;
    if tuple[1] != "1" {
        return Err(DiscoverySdkError::InvalidTag("discovery-worker-action"));
    }
    let operation = parse_operation(&tuple[2])?;
    let required = if operation == DiscoveryWorkerOperation::Claim {
        ["p", "worker", "discovery-worker-action"].as_slice()
    } else {
        ["p", "worker", "run", "lease", "discovery-worker-action"].as_slice()
    };
    require_exact_tag_names(event, required, "discovery worker action")?;
    let relay_pubkey = parse_pubkey(required_scalar_tag(event, "p")?, "discovery worker action")?;
    let request_id = parse_uuid(&tuple[3], "discovery worker action")?;
    let idempotency_key = parse_uuid(&tuple[4], "discovery worker action")?;
    let worker_id = parse_uuid(
        required_scalar_tag(event, "worker")?,
        "discovery worker action",
    )?;
    let content: DiscoveryWorkerActionContent =
        parse_canonical_content(&event.content, "discovery worker action")?;
    if content.schema != ACTION_SCHEMA
        || content.operation != operation
        || content.request_id != request_id
        || content.idempotency_key != idempotency_key
        || content.worker_id != worker_id
    {
        return Err(DiscoverySdkError::TagContentMismatch(
            "discovery worker action",
        ));
    }
    let action = match operation {
        DiscoveryWorkerOperation::Claim
            if content.run_id.is_none()
                && content.lease_id.is_none()
                && content.checkpoint.is_none() =>
        {
            DiscoveryWorkerAction::Claim(DiscoveryWorkerClaimRequest {
                request_id,
                idempotency_key,
                worker_id,
            })
        }
        DiscoveryWorkerOperation::Heartbeat | DiscoveryWorkerOperation::Complete
            if content.checkpoint.is_none() =>
        {
            let request = parse_lease_content(event, &content)?;
            if operation == DiscoveryWorkerOperation::Heartbeat {
                DiscoveryWorkerAction::Heartbeat(request)
            } else {
                DiscoveryWorkerAction::Complete(request)
            }
        }
        DiscoveryWorkerOperation::Checkpoint => {
            let lease = parse_lease_content(event, &content)?;
            let checkpoint = content
                .checkpoint
                .ok_or(DiscoverySdkError::TagContentMismatch(
                    "discovery worker action",
                ))?;
            validate_checkpoint(&checkpoint)?;
            DiscoveryWorkerAction::Checkpoint(DiscoveryWorkerCheckpointRequest {
                lease,
                checkpoint,
            })
        }
        _ => {
            return Err(DiscoverySdkError::TagContentMismatch(
                "discovery worker action",
            ));
        }
    };
    Ok(ParsedDiscoveryWorkerAction {
        relay_pubkey,
        action,
    })
}

fn parse_lease_content(
    event: &Event,
    content: &DiscoveryWorkerActionContent,
) -> Result<DiscoveryWorkerLeaseRequest, DiscoverySdkError> {
    let run_id = parse_uuid(
        required_scalar_tag(event, "run")?,
        "discovery worker action",
    )?;
    let lease_id = parse_uuid(
        required_scalar_tag(event, "lease")?,
        "discovery worker action",
    )?;
    if content.run_id != Some(run_id) || content.lease_id != Some(lease_id) {
        return Err(DiscoverySdkError::TagContentMismatch(
            "discovery worker action",
        ));
    }
    Ok(DiscoveryWorkerLeaseRequest {
        request_id: content.request_id,
        idempotency_key: content.idempotency_key,
        worker_id: content.worker_id,
        run_id,
        lease_id,
    })
}

/// Build the exact relay-signable worker receipt envelope.
pub fn build_discovery_worker_receipt(
    actor_pubkey: PublicKey,
    action_event_id: EventId,
    receipt: &DiscoveryWorkerReceipt,
) -> Result<EventBuilder, DiscoverySdkError> {
    validate_receipt(receipt)?;
    let actor_text = actor_pubkey.to_hex();
    let action_text = action_event_id.to_hex();
    let worker_text = receipt.worker_id.to_string();
    let request_text = receipt.request_id.to_string();
    let idempotency_text = receipt.idempotency_key.to_string();
    let content = DiscoveryWorkerReceiptContent {
        schema: RECEIPT_SCHEMA.to_owned(),
        receipt: receipt.clone(),
    };
    let tags = [
        scalar_tag("p", &actor_text)?,
        tuple_tag(&["e", &action_text, "", "discovery-worker-action"])?,
        scalar_tag("worker", &worker_text)?,
        tuple_tag(&[
            "discovery-worker-receipt",
            "1",
            operation_tag(receipt.operation),
            &request_text,
            &idempotency_text,
            &worker_text,
        ])?,
    ];
    Ok(EventBuilder::new(
        Kind::Custom(KIND_DISCOVERY_WORKER_RECEIPT as u16),
        canonical_content(&content, "discovery worker receipt")?,
    )
    .tags(tags))
}

/// Parse an exact relay-authored worker receipt envelope.
pub fn parse_discovery_worker_receipt(
    event: &Event,
) -> Result<ParsedDiscoveryWorkerReceipt, DiscoverySdkError> {
    require_kind(event, KIND_DISCOVERY_WORKER_RECEIPT)?;
    require_exact_tag_names(
        event,
        &["p", "e", "worker", "discovery-worker-receipt"],
        "discovery worker receipt",
    )?;
    let actor_pubkey = parse_pubkey(required_scalar_tag(event, "p")?, "discovery worker receipt")?;
    let action_ref = required_tuple_tag(event, "e", 4)?;
    if !action_ref[2].is_empty() || action_ref[3] != "discovery-worker-action" {
        return Err(DiscoverySdkError::InvalidTag("e"));
    }
    let action_event_id = EventId::from_hex(&action_ref[1])
        .map_err(|_| DiscoverySdkError::InvalidEnvelope("discovery worker receipt"))?;
    let worker_id = parse_uuid(
        required_scalar_tag(event, "worker")?,
        "discovery worker receipt",
    )?;
    let tuple = required_tuple_tag(event, "discovery-worker-receipt", 6)?;
    if tuple[1] != "1" {
        return Err(DiscoverySdkError::InvalidTag("discovery-worker-receipt"));
    }
    let operation = parse_operation(&tuple[2])?;
    let request_id = parse_uuid(&tuple[3], "discovery worker receipt")?;
    let idempotency_key = parse_uuid(&tuple[4], "discovery worker receipt")?;
    if tuple[5] != worker_id.to_string() {
        return Err(DiscoverySdkError::TagContentMismatch(
            "discovery worker receipt",
        ));
    }
    let content: DiscoveryWorkerReceiptContent =
        parse_canonical_content(&event.content, "discovery worker receipt")?;
    if content.schema != RECEIPT_SCHEMA
        || content.receipt.operation != operation
        || content.receipt.request_id != request_id
        || content.receipt.idempotency_key != idempotency_key
        || content.receipt.worker_id != worker_id
    {
        return Err(DiscoverySdkError::TagContentMismatch(
            "discovery worker receipt",
        ));
    }
    validate_receipt(&content.receipt)?;
    Ok(ParsedDiscoveryWorkerReceipt {
        event_id: event.id,
        actor_pubkey,
        action_event_id,
        receipt: content.receipt,
    })
}

fn validate_lease_request(request: &DiscoveryWorkerLeaseRequest) -> Result<(), DiscoverySdkError> {
    for value in [
        request.request_id,
        request.idempotency_key,
        request.worker_id,
        request.run_id,
        request.lease_id,
    ] {
        validate_uuid(value, "discovery worker action")?;
    }
    Ok(())
}

fn validate_checkpoint(checkpoint: &DiscoveryWorkerCheckpoint) -> Result<(), DiscoverySdkError> {
    if checkpoint.sequence == 0 {
        return Err(DiscoverySdkError::InvalidEnvelope(
            "discovery worker checkpoint",
        ));
    }
    match checkpoint.kind {
        DiscoveryCheckpointKind::ProviderSubmitted => {
            let request_id = checkpoint.provider_request_id.as_deref().ok_or(
                DiscoverySdkError::InvalidEnvelope("provider submitted checkpoint"),
            )?;
            validate_provider_request_id(request_id)?;
            if checkpoint.item_count.is_some() {
                return Err(DiscoverySdkError::InvalidEnvelope(
                    "provider submitted checkpoint",
                ));
            }
        }
        DiscoveryCheckpointKind::ProviderResultsReady => {
            if checkpoint.provider_request_id.is_some() || checkpoint.item_count.is_none() {
                return Err(DiscoverySdkError::InvalidEnvelope(
                    "provider results checkpoint",
                ));
            }
        }
    }
    Ok(())
}

fn validate_provider_request_id(value: &str) -> Result<(), DiscoverySdkError> {
    let valid = !value.is_empty()
        && value.len() <= MAX_PROVIDER_REQUEST_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err(DiscoverySdkError::InvalidEnvelope(
            "discovery provider request id",
        ))
    }
}

fn validate_receipt(receipt: &DiscoveryWorkerReceipt) -> Result<(), DiscoverySdkError> {
    validate_uuid(receipt.request_id, "discovery worker receipt")?;
    validate_uuid(receipt.idempotency_key, "discovery worker receipt")?;
    validate_uuid(receipt.worker_id, "discovery worker receipt")?;
    match &receipt.outcome {
        DiscoveryWorkerReceiptOutcome::Idle => {}
        DiscoveryWorkerReceiptOutcome::Lease(lease) => {
            if lease.worker_id != receipt.worker_id || lease.attempt == 0 {
                return Err(DiscoverySdkError::InvalidEnvelope(
                    "discovery worker receipt",
                ));
            }
            validate_uuid(lease.lease_id, "discovery worker receipt")?;
            validate_run_projection(&lease.run)?;
            if let Some(checkpoint) = &lease.last_checkpoint {
                validate_checkpoint(checkpoint)?;
            }
        }
        DiscoveryWorkerReceiptOutcome::LostLease(run)
        | DiscoveryWorkerReceiptOutcome::Completed(run) => validate_run_projection(run)?,
    }
    Ok(())
}

fn validate_run_projection(run: &DiscoveryRunProjection) -> Result<(), DiscoverySdkError> {
    validate_uuid(run.run_id, "discovery worker receipt")?;
    validate_uuid(run.campaign_id, "discovery worker receipt")?;
    if run.total_steps == 0 || run.completed_steps > run.total_steps {
        return Err(DiscoverySdkError::InvalidEnvelope(
            "discovery worker receipt",
        ));
    }
    if run.state == DiscoveryRunState::Succeeded && run.completed_steps != run.total_steps {
        return Err(DiscoverySdkError::InvalidEnvelope(
            "discovery worker receipt",
        ));
    }
    Ok(())
}

fn operation_tag(operation: DiscoveryWorkerOperation) -> &'static str {
    match operation {
        DiscoveryWorkerOperation::Claim => "claim",
        DiscoveryWorkerOperation::Heartbeat => "heartbeat",
        DiscoveryWorkerOperation::Checkpoint => "checkpoint",
        DiscoveryWorkerOperation::Complete => "complete",
    }
}

fn parse_operation(value: &str) -> Result<DiscoveryWorkerOperation, DiscoverySdkError> {
    match value {
        "claim" => Ok(DiscoveryWorkerOperation::Claim),
        "heartbeat" => Ok(DiscoveryWorkerOperation::Heartbeat),
        "checkpoint" => Ok(DiscoveryWorkerOperation::Checkpoint),
        "complete" => Ok(DiscoveryWorkerOperation::Complete),
        _ => Err(DiscoverySdkError::InvalidEnvelope(
            "discovery worker action",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::discovery_worker::DiscoveryProvider;
    use buzz_core::{
        discovery::{DiscoveryRunProjection, DiscoveryRunState},
        discovery_worker::{DiscoveryWorkerLeaseProjection, DiscoveryWorkerReceiptOutcome},
    };
    use chrono::{TimeZone, Utc};
    use nostr::{EventBuilder, JsonUtil, Keys, Tag};

    fn lease() -> DiscoveryWorkerLeaseRequest {
        DiscoveryWorkerLeaseRequest {
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            worker_id: Uuid::from_u128(3),
            run_id: Uuid::from_u128(4),
            lease_id: Uuid::from_u128(5),
        }
    }

    fn run() -> DiscoveryRunProjection {
        DiscoveryRunProjection {
            run_id: Uuid::from_u128(4),
            campaign_id: Uuid::from_u128(6),
            state: DiscoveryRunState::Running,
            completed_steps: 0,
            total_steps: 1,
            cancel_requested: false,
            terminal_reason: None,
            created_at: Utc.timestamp_opt(1_800_000_000, 0).single().unwrap(),
            updated_at: Utc.timestamp_opt(1_800_000_000, 0).single().unwrap(),
        }
    }

    #[test]
    fn every_worker_action_round_trips() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let claim = DiscoveryWorkerClaimRequest {
            request_id: Uuid::from_u128(10),
            idempotency_key: Uuid::from_u128(11),
            worker_id: Uuid::from_u128(12),
        };
        let checkpoint = DiscoveryWorkerCheckpointRequest {
            lease: lease(),
            checkpoint: DiscoveryWorkerCheckpoint {
                sequence: 1,
                kind: DiscoveryCheckpointKind::ProviderSubmitted,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: Some("request_123".into()),
                item_count: None,
            },
        };
        let events = [
            build_discovery_worker_claim_action(relay.public_key(), &claim)
                .unwrap()
                .sign_with_keys(&actor)
                .unwrap(),
            build_discovery_worker_heartbeat_action(relay.public_key(), &lease())
                .unwrap()
                .sign_with_keys(&actor)
                .unwrap(),
            build_discovery_worker_checkpoint_action(relay.public_key(), &checkpoint)
                .unwrap()
                .sign_with_keys(&actor)
                .unwrap(),
            build_discovery_worker_complete_action(relay.public_key(), &lease())
                .unwrap()
                .sign_with_keys(&actor)
                .unwrap(),
        ];
        assert!(matches!(
            parse_discovery_worker_action(&events[0]).unwrap().action,
            DiscoveryWorkerAction::Claim(_)
        ));
        assert!(matches!(
            parse_discovery_worker_action(&events[1]).unwrap().action,
            DiscoveryWorkerAction::Heartbeat(_)
        ));
        assert!(matches!(
            parse_discovery_worker_action(&events[2]).unwrap().action,
            DiscoveryWorkerAction::Checkpoint(_)
        ));
        assert!(matches!(
            parse_discovery_worker_action(&events[3]).unwrap().action,
            DiscoveryWorkerAction::Complete(_)
        ));
    }

    #[test]
    fn provider_request_id_rejects_secret_punctuation() {
        let request = DiscoveryWorkerCheckpointRequest {
            lease: lease(),
            checkpoint: DiscoveryWorkerCheckpoint {
                sequence: 1,
                kind: DiscoveryCheckpointKind::ProviderSubmitted,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: Some("sk-live secret/value".into()),
                item_count: None,
            },
        };
        assert!(
            build_discovery_worker_checkpoint_action(Keys::generate().public_key(), &request)
                .is_err()
        );
    }

    #[test]
    fn action_parser_rejects_extra_tags() {
        let relay = Keys::generate();
        let actor = Keys::generate();
        let request = DiscoveryWorkerClaimRequest {
            request_id: Uuid::from_u128(10),
            idempotency_key: Uuid::from_u128(11),
            worker_id: Uuid::from_u128(12),
        };
        let original = build_discovery_worker_claim_action(relay.public_key(), &request)
            .unwrap()
            .sign_with_keys(&actor)
            .unwrap();
        let mut tags = original.tags.iter().cloned().collect::<Vec<_>>();
        tags.push(Tag::parse(["api_key", "forbidden"]).unwrap());
        let tampered = EventBuilder::new(original.kind, original.content)
            .tags(tags)
            .sign_with_keys(&actor)
            .unwrap();
        assert!(matches!(
            parse_discovery_worker_action(&tampered),
            Err(DiscoverySdkError::UnexpectedTag("discovery worker action"))
        ));
    }

    #[test]
    fn receipt_round_trips_and_never_includes_unrelated_local_secret() {
        let actor = Keys::generate();
        let relay = Keys::generate();
        let action = build_discovery_worker_heartbeat_action(relay.public_key(), &lease())
            .unwrap()
            .sign_with_keys(&actor)
            .unwrap();
        let receipt = DiscoveryWorkerReceipt {
            operation: DiscoveryWorkerOperation::Heartbeat,
            request_id: Uuid::from_u128(1),
            idempotency_key: Uuid::from_u128(2),
            worker_id: Uuid::from_u128(3),
            outcome: DiscoveryWorkerReceiptOutcome::Lease(DiscoveryWorkerLeaseProjection {
                worker_id: Uuid::from_u128(3),
                lease_id: Uuid::from_u128(5),
                attempt: 1,
                lease_until: Utc.timestamp_opt(1_800_000_030, 0).single().unwrap(),
                run: run(),
                last_checkpoint: None,
            }),
        };
        let event = build_discovery_worker_receipt(actor.public_key(), action.id, &receipt)
            .unwrap()
            .sign_with_keys(&relay)
            .unwrap();
        let parsed = parse_discovery_worker_receipt(&event).unwrap();
        assert_eq!(parsed.event_id, event.id);
        assert_eq!(parsed.actor_pubkey, actor.public_key());
        assert_eq!(parsed.action_event_id, action.id);
        assert_eq!(parsed.receipt, receipt);
        assert!(!event
            .as_json()
            .contains("outscraper-secret-never-serialized"));
    }
}
