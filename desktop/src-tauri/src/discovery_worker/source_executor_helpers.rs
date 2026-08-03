use std::time::Duration;

use buzz_core_pkg::discovery_worker::{
    DiscoveryRunSourceProjection, DiscoveryRunSourceStatus, DiscoveryWorkerLeaseProjection,
    DiscoveryWorkerLeaseRequest,
};
use uuid::Uuid;

use super::coordinator::SourceExecution;

pub(super) fn terminal_source_execution(
    state: &DiscoveryRunSourceProjection,
) -> Option<SourceExecution> {
    match state.status {
        DiscoveryRunSourceStatus::Completed
        | DiscoveryRunSourceStatus::Exhausted
        | DiscoveryRunSourceStatus::SkippedTargetMet => {
            Some(SourceExecution::Succeeded { retained: 0 })
        }
        DiscoveryRunSourceStatus::Failed | DiscoveryRunSourceStatus::OutcomeUnknown => {
            Some(SourceExecution::Failed { retained: 0 })
        }
        DiscoveryRunSourceStatus::Cancelled => Some(SourceExecution::Cancelled),
        DiscoveryRunSourceStatus::Pending | DiscoveryRunSourceStatus::Active => None,
    }
}

pub(super) fn lease_request(lease: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerLeaseRequest {
    DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: lease.worker_id,
        run_id: lease.run.run_id,
        lease_id: lease.lease_id,
    }
}

pub(super) fn heartbeat_interval(lease: &DiscoveryWorkerLeaseProjection) -> Duration {
    let remaining = (lease.lease_until - chrono::Utc::now())
        .to_std()
        .unwrap_or(Duration::from_millis(150));
    (remaining / 3).clamp(Duration::from_millis(50), Duration::from_secs(2))
}
