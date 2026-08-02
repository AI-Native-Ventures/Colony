use std::{sync::atomic::Ordering, time::Duration};

use buzz_core_pkg::discovery_worker::{
    DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest, DiscoveryWorkerLeaseProjection,
    DiscoveryWorkerLeaseRequest, DiscoveryWorkerReceiptOutcome,
};
use tauri::{AppHandle, Manager as _};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    adapter::FakeOutscraperAdapter,
    installation::load_or_create_worker_id,
    protocol::{RelayWorkerProtocol, WorkerProtocol},
};
use crate::{app_state::AppState, discovery_credentials, relay};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const FAKE_STEP_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostRunOutcome {
    NoCredential,
    Idle,
    LostLease,
    Completed,
}

pub(crate) fn start_fake_local_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let app_data_dir = match app.path().app_data_dir() {
            Ok(path) => path,
            Err(_) => return,
        };
        let worker_id = match load_or_create_worker_id(&app_data_dir) {
            Ok(id) => id,
            Err(error) => {
                eprintln!("buzz-desktop: Discovery worker identity unavailable: {error}");
                return;
            }
        };

        loop {
            let state = app.state::<AppState>();
            if state.shutdown_started.load(Ordering::Acquire) {
                return;
            }
            let relay_url = state
                .relay_url_override
                .lock()
                .ok()
                .and_then(|value| value.clone());
            let Some(relay_url) = relay_url else {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            };
            let keys = match state.signing_keys() {
                Ok(keys) => keys,
                Err(_) => return,
            };
            let generation = super::workspace_generation();
            let api_base_url = relay::relay_http_base_url(&relay_url);
            let protocol = match RelayWorkerProtocol::connect(
                &state,
                keys,
                api_base_url,
                worker_id,
                generation,
            )
            .await
            {
                Ok(protocol) => protocol,
                Err(_) => {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
            };
            let _ = run_once(&protocol, worker_id, FAKE_STEP_DELAY).await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

async fn run_once<P: WorkerProtocol>(
    protocol: &P,
    worker_id: Uuid,
    step_delay: Duration,
) -> Result<HostRunOutcome, String> {
    run_once_with_loader(protocol, worker_id, step_delay, || {
        discovery_credentials::load_outscraper_credential()
    })
    .await
}

async fn run_once_with_loader<P, F>(
    protocol: &P,
    worker_id: Uuid,
    step_delay: Duration,
    load: F,
) -> Result<HostRunOutcome, String>
where
    P: WorkerProtocol,
    F: FnOnce() -> Result<Option<Zeroizing<String>>, String>,
{
    let Some(credential) = load()? else {
        return Ok(HostRunOutcome::NoCredential);
    };
    run_once_with_credential(protocol, worker_id, step_delay, credential).await
}

async fn run_once_with_credential<P: WorkerProtocol>(
    protocol: &P,
    worker_id: Uuid,
    step_delay: Duration,
    credential: Zeroizing<String>,
) -> Result<HostRunOutcome, String> {
    let claim = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id,
    };
    let lease = match protocol.claim(claim).await? {
        DiscoveryWorkerReceiptOutcome::Idle => return Ok(HostRunOutcome::Idle),
        DiscoveryWorkerReceiptOutcome::Lease(lease) => lease,
        _ => return Err("Discovery claim returned an invalid outcome".to_string()),
    };
    let adapter = FakeOutscraperAdapter::new(&credential);
    for checkpoint in adapter.remaining_checkpoints(&lease) {
        if !wait_with_heartbeats(protocol, &lease, step_delay).await? {
            return Ok(HostRunOutcome::LostLease);
        }
        let request = DiscoveryWorkerCheckpointRequest {
            lease: lease_request(&lease),
            checkpoint,
        };
        match protocol.checkpoint(request).await? {
            DiscoveryWorkerReceiptOutcome::Lease(_) => {}
            DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                return Ok(HostRunOutcome::LostLease);
            }
            _ => return Err("Discovery checkpoint returned an invalid outcome".to_string()),
        }
    }
    if !heartbeat(protocol, &lease).await? {
        return Ok(HostRunOutcome::LostLease);
    }
    match protocol.complete(lease_request(&lease)).await? {
        DiscoveryWorkerReceiptOutcome::Completed(_) => Ok(HostRunOutcome::Completed),
        DiscoveryWorkerReceiptOutcome::LostLease(_) => Ok(HostRunOutcome::LostLease),
        _ => Err("Discovery completion returned an invalid outcome".to_string()),
    }
}

async fn wait_with_heartbeats<P: WorkerProtocol>(
    protocol: &P,
    lease: &DiscoveryWorkerLeaseProjection,
    step_delay: Duration,
) -> Result<bool, String> {
    if !heartbeat(protocol, lease).await? {
        return Ok(false);
    }
    if step_delay.is_zero() {
        return Ok(true);
    }
    let interval = heartbeat_interval(lease);
    let started = tokio::time::Instant::now();
    while started.elapsed() < step_delay {
        let remaining = step_delay.saturating_sub(started.elapsed());
        tokio::time::sleep(interval.min(remaining)).await;
        if started.elapsed() < step_delay && !heartbeat(protocol, lease).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn heartbeat<P: WorkerProtocol>(
    protocol: &P,
    lease: &DiscoveryWorkerLeaseProjection,
) -> Result<bool, String> {
    match protocol.heartbeat(lease_request(lease)).await? {
        DiscoveryWorkerReceiptOutcome::Lease(_) => Ok(true),
        DiscoveryWorkerReceiptOutcome::LostLease(_) => Ok(false),
        _ => Err("Discovery heartbeat returned an invalid outcome".to_string()),
    }
}

fn heartbeat_interval(lease: &DiscoveryWorkerLeaseProjection) -> Duration {
    let remaining = (lease.lease_until - chrono::Utc::now())
        .to_std()
        .unwrap_or(Duration::from_millis(150));
    (remaining / 3).clamp(Duration::from_millis(50), Duration::from_secs(5))
}

fn lease_request(lease: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerLeaseRequest {
    DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: lease.worker_id,
        run_id: lease.run.run_id,
        lease_id: lease.lease_id,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use buzz_core_pkg::{
        discovery::{DiscoveryRunProjection, DiscoveryRunState},
        discovery_worker::{DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerCheckpoint},
    };
    use chrono::Utc;

    use super::*;
    use crate::discovery_worker::protocol::ProtocolFuture;

    struct FakeProtocol {
        outcomes: Mutex<VecDeque<DiscoveryWorkerReceiptOutcome>>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeProtocol {
        fn new(outcomes: Vec<DiscoveryWorkerReceiptOutcome>) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn next(&self, call: &'static str) -> Result<DiscoveryWorkerReceiptOutcome, String> {
            self.calls.lock().expect("calls").push(call);
            self.outcomes
                .lock()
                .expect("outcomes")
                .pop_front()
                .ok_or_else(|| format!("no fixture outcome for {call}"))
        }
    }

    impl WorkerProtocol for FakeProtocol {
        fn claim(&self, _: DiscoveryWorkerClaimRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("claim") })
        }

        fn heartbeat(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("heartbeat") })
        }

        fn checkpoint(&self, _: DiscoveryWorkerCheckpointRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("checkpoint") })
        }

        fn complete(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("complete") })
        }
    }

    fn run_projection() -> DiscoveryRunProjection {
        DiscoveryRunProjection {
            run_id: Uuid::new_v4(),
            campaign_id: Uuid::new_v4(),
            state: DiscoveryRunState::Running,
            completed_steps: 0,
            total_steps: 2,
            cancel_requested: false,
            terminal_reason: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn lease(last_checkpoint: Option<DiscoveryWorkerCheckpoint>) -> DiscoveryWorkerLeaseProjection {
        DiscoveryWorkerLeaseProjection {
            worker_id: Uuid::new_v4(),
            lease_id: Uuid::new_v4(),
            attempt: 1,
            lease_until: Utc::now() + chrono::Duration::seconds(30),
            run: run_projection(),
            last_checkpoint,
        }
    }

    fn lease_outcome(value: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
        DiscoveryWorkerReceiptOutcome::Lease(value.clone())
    }

    #[tokio::test]
    async fn missing_credential_sends_zero_claim_actions() {
        let protocol = FakeProtocol::new(Vec::new());
        let outcome = run_once_with_loader(&protocol, Uuid::new_v4(), Duration::ZERO, || Ok(None))
            .await
            .expect("missing credential is not an error");
        assert_eq!(outcome, HostRunOutcome::NoCredential);
        assert!(protocol.calls.lock().expect("calls").is_empty());
    }

    #[tokio::test]
    async fn fresh_run_heartbeats_checkpoints_twice_and_completes() {
        let lease = lease(None);
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
        ]);
        let outcome = run_once_with_credential(
            &protocol,
            lease.worker_id,
            Duration::ZERO,
            Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("fresh run");
        assert_eq!(outcome, HostRunOutcome::Completed);
        assert_eq!(
            *protocol.calls.lock().expect("calls"),
            [
                "claim",
                "heartbeat",
                "checkpoint",
                "heartbeat",
                "checkpoint",
                "heartbeat",
                "complete"
            ]
        );
    }

    #[tokio::test]
    async fn reclaimed_run_resumes_after_provider_submitted() {
        let submitted = DiscoveryWorkerCheckpoint {
            sequence: 1,
            kind: DiscoveryCheckpointKind::ProviderSubmitted,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: Some("fixture-request".to_string()),
            item_count: None,
        };
        let lease = lease(Some(submitted));
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
        ]);
        let outcome = run_once_with_credential(
            &protocol,
            lease.worker_id,
            Duration::ZERO,
            Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("resumed run");
        assert_eq!(outcome, HostRunOutcome::Completed);
        assert_eq!(
            protocol
                .calls
                .lock()
                .expect("calls")
                .iter()
                .filter(|call| **call == "checkpoint")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn lost_lease_during_paused_step_sends_no_checkpoint_or_completion() {
        let mut lease = lease(None);
        lease.lease_until = Utc::now() + chrono::Duration::milliseconds(150);
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::LostLease(lease.run.clone()),
        ]);
        let outcome = run_once_with_credential(
            &protocol,
            lease.worker_id,
            Duration::from_millis(180),
            Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("lost lease");
        assert_eq!(outcome, HostRunOutcome::LostLease);
        assert!(!protocol
            .calls
            .lock()
            .expect("calls")
            .iter()
            .any(|call| *call == "checkpoint" || *call == "complete"));
    }
}
