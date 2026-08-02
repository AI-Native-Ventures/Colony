//! Core contracts for trusted local Discovery workers.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::discovery::DiscoveryRunProjection;

/// Operation requested by a trusted local Discovery worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryWorkerOperation {
    /// Claim the oldest eligible workspace run.
    Claim,
    /// Extend a currently owned lease.
    Heartbeat,
    /// Commit a monotonic non-secret execution checkpoint.
    Checkpoint,
    /// Mark a currently owned run successful.
    Complete,
}

/// External provider represented by a worker checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryProvider {
    /// Outscraper Google Maps business discovery.
    Outscraper,
}

/// Durable boundary reached by the local worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryCheckpointKind {
    /// The provider accepted a request and returned an opaque request reference.
    ProviderSubmitted,
    /// The provider request returned a bounded number of results.
    ProviderResultsReady,
}

/// Request to claim one eligible workspace run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerClaimRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Stable identifier for this local worker installation.
    pub worker_id: Uuid,
}

/// Request operating on a currently owned worker lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Stable identifier for this local worker installation.
    pub worker_id: Uuid,
    /// Durable run being operated.
    pub run_id: Uuid,
    /// Random relay-issued fencing token for the current lease.
    pub lease_id: Uuid,
}

/// Strict, non-secret checkpoint persisted for restart recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpoint {
    /// Monotonic one-based checkpoint sequence within the run.
    pub sequence: u32,
    /// Durable execution boundary represented by this checkpoint.
    pub kind: DiscoveryCheckpointKind,
    /// Provider associated with the checkpoint.
    pub provider: DiscoveryProvider,
    /// Strict opaque provider reference, only for `provider_submitted`.
    pub provider_request_id: Option<String>,
    /// Returned result count, only for `provider_results_ready`.
    pub item_count: Option<u32>,
}

/// Request to commit a checkpoint under a current lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerCheckpointRequest {
    /// Current lease identity and command retry identifiers.
    #[serde(flatten)]
    pub lease: DiscoveryWorkerLeaseRequest,
    /// Monotonic checkpoint to persist.
    pub checkpoint: DiscoveryWorkerCheckpoint,
}

/// Validated operation-specific local worker action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryWorkerAction {
    /// Claim one eligible workspace run.
    Claim(DiscoveryWorkerClaimRequest),
    /// Extend a current lease.
    Heartbeat(DiscoveryWorkerLeaseRequest),
    /// Persist restart-safe progress.
    Checkpoint(DiscoveryWorkerCheckpointRequest),
    /// Complete a current run.
    Complete(DiscoveryWorkerLeaseRequest),
}

impl DiscoveryWorkerAction {
    /// Operation represented by this action.
    pub const fn operation(&self) -> DiscoveryWorkerOperation {
        match self {
            Self::Claim(_) => DiscoveryWorkerOperation::Claim,
            Self::Heartbeat(_) => DiscoveryWorkerOperation::Heartbeat,
            Self::Checkpoint(_) => DiscoveryWorkerOperation::Checkpoint,
            Self::Complete(_) => DiscoveryWorkerOperation::Complete,
        }
    }

    /// Command-attempt identifier carried by this action.
    pub const fn request_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.request_id,
            Self::Heartbeat(value) | Self::Complete(value) => value.request_id,
            Self::Checkpoint(value) => value.lease.request_id,
        }
    }

    /// Stable retry key carried by this action.
    pub const fn idempotency_key(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.idempotency_key,
            Self::Heartbeat(value) | Self::Complete(value) => value.idempotency_key,
            Self::Checkpoint(value) => value.lease.idempotency_key,
        }
    }

    /// Local worker installation identifier carried by this action.
    pub const fn worker_id(&self) -> Uuid {
        match self {
            Self::Claim(value) => value.worker_id,
            Self::Heartbeat(value) | Self::Complete(value) => value.worker_id,
            Self::Checkpoint(value) => value.lease.worker_id,
        }
    }
}

/// Current fenced lease returned to a local worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerLeaseProjection {
    /// Stable local worker installation identifier.
    pub worker_id: Uuid,
    /// Relay-issued random fencing token.
    pub lease_id: Uuid,
    /// Monotonically increasing run attempt number.
    pub attempt: u32,
    /// Relay-owned lease expiry.
    pub lease_until: DateTime<Utc>,
    /// Safe run projection.
    pub run: DiscoveryRunProjection,
    /// Latest durable restart checkpoint, when present.
    pub last_checkpoint: Option<DiscoveryWorkerCheckpoint>,
}

/// Result of a worker command safe to return in a private relay receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status", content = "value")]
pub enum DiscoveryWorkerReceiptOutcome {
    /// No workspace run was currently eligible.
    Idle,
    /// The worker owns or renewed this lease.
    Lease(DiscoveryWorkerLeaseProjection),
    /// The supplied lease is no longer current.
    LostLease(DiscoveryRunProjection),
    /// The current lease completed its run.
    Completed(DiscoveryRunProjection),
}

/// Relay-signed result of one local worker command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryWorkerReceipt {
    /// Operation processed by the relay.
    pub operation: DiscoveryWorkerOperation,
    /// Command-attempt identifier copied from the action.
    pub request_id: Uuid,
    /// Stable retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Local worker installation addressed by the result.
    pub worker_id: Uuid,
    /// Private operation outcome.
    pub outcome: DiscoveryWorkerReceiptOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_operation_json_is_stable() {
        assert_eq!(
            serde_json::to_string(&DiscoveryWorkerOperation::Checkpoint)
                .expect("serialize operation"),
            "\"checkpoint\""
        );
    }

    #[test]
    fn claim_rejects_unknown_fields() {
        let value = serde_json::json!({
            "request_id": Uuid::new_v4(),
            "idempotency_key": Uuid::new_v4(),
            "worker_id": Uuid::new_v4(),
            "api_key": "must-not-fit-the-schema"
        });
        assert!(serde_json::from_value::<DiscoveryWorkerClaimRequest>(value).is_err());
    }
}
