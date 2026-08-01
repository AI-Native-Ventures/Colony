//! Core contracts for Colony business Discovery runs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Operation requested through a signed Discovery action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryOperation {
    /// Create a new durable run for an existing campaign reference.
    Start,
    /// Read the current durable run projection.
    Status,
    /// Request that an active run stop before its next committed step.
    Cancel,
}

/// Durable lifecycle state of a Discovery run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryRunState {
    /// Accepted but not yet claimed by a worker.
    Queued,
    /// Claimed by a worker and eligible to make progress.
    Running,
    /// Every configured step committed successfully.
    Succeeded,
    /// Stopped by an actor request or entitlement revocation.
    Cancelled,
    /// Stopped because the executor failed.
    Failed,
}

impl DiscoveryRunState {
    /// Whether no further progress may be committed for this state.
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Cancelled | Self::Failed)
    }
}

/// Stable reason attached to a terminal Discovery run when one is required.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryTerminalReason {
    /// An authorized workspace actor requested cancellation.
    CancelledByActor,
    /// The workspace lost its active Discovery entitlement.
    EntitlementRevoked,
    /// The configured executor returned a terminal failure.
    ExecutorFailed,
}

/// Payload of a signed start request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryStartRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Opaque reference to the campaign that owns the run.
    pub campaign_id: Uuid,
}

/// Payload of a signed status or cancel request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunRequest {
    /// Unique identifier for this command attempt.
    pub request_id: Uuid,
    /// Stable retry key for this logical command.
    pub idempotency_key: Uuid,
    /// Durable run being inspected or cancelled.
    pub run_id: Uuid,
}

/// Validated operation-specific Discovery action payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryAction {
    /// Start a new run.
    Start(DiscoveryStartRequest),
    /// Read an existing run.
    Status(DiscoveryRunRequest),
    /// Request cancellation of an existing run.
    Cancel(DiscoveryRunRequest),
}

impl DiscoveryAction {
    /// Operation represented by this action.
    pub const fn operation(&self) -> DiscoveryOperation {
        match self {
            Self::Start(_) => DiscoveryOperation::Start,
            Self::Status(_) => DiscoveryOperation::Status,
            Self::Cancel(_) => DiscoveryOperation::Cancel,
        }
    }

    /// Command-attempt identifier carried by this action.
    pub const fn request_id(&self) -> Uuid {
        match self {
            Self::Start(request) => request.request_id,
            Self::Status(request) | Self::Cancel(request) => request.request_id,
        }
    }

    /// Stable retry key carried by this action.
    pub const fn idempotency_key(&self) -> Uuid {
        match self {
            Self::Start(request) => request.idempotency_key,
            Self::Status(request) | Self::Cancel(request) => request.idempotency_key,
        }
    }
}

/// Non-confidential projection safe to carry in a relay-signed receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryRunProjection {
    /// Durable run identifier.
    pub run_id: Uuid,
    /// Opaque campaign reference supplied at start.
    pub campaign_id: Uuid,
    /// Current durable lifecycle state.
    pub state: DiscoveryRunState,
    /// Number of committed executor steps.
    pub completed_steps: u32,
    /// Fixed number of steps configured when the run was accepted.
    pub total_steps: u32,
    /// Whether an authorized actor requested cancellation.
    pub cancel_requested: bool,
    /// Stable terminal reason, when applicable.
    pub terminal_reason: Option<DiscoveryTerminalReason>,
    /// Time at which the durable run was created.
    pub created_at: DateTime<Utc>,
    /// Time at which the durable run was last changed.
    pub updated_at: DateTime<Utc>,
}

/// Public content of a relay-signed Discovery receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DiscoveryReceipt {
    /// Operation processed by the relay.
    pub operation: DiscoveryOperation,
    /// Command-attempt identifier copied from the action.
    pub request_id: Uuid,
    /// Stable retry key copied from the action.
    pub idempotency_key: Uuid,
    /// Safe point-in-time run projection.
    pub run: DiscoveryRunProjection,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states_are_terminal() {
        assert!(!DiscoveryRunState::Queued.is_terminal());
        assert!(!DiscoveryRunState::Running.is_terminal());
        assert!(DiscoveryRunState::Succeeded.is_terminal());
        assert!(DiscoveryRunState::Cancelled.is_terminal());
        assert!(DiscoveryRunState::Failed.is_terminal());
    }

    #[test]
    fn entitlement_revocation_is_a_stable_terminal_reason() {
        let json = serde_json::to_string(&DiscoveryTerminalReason::EntitlementRevoked)
            .expect("test serialization must succeed");
        assert_eq!(json, "\"entitlement_revoked\"");
    }
}
