use std::{future::Future, pin::Pin, sync::atomic::Ordering, time::Duration};

use buzz_core_pkg::discovery_worker::{
    DiscoveryCheckpointKind, DiscoveryProvider, DiscoveryWorkerCheckpoint,
    DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest, DiscoveryWorkerLeaseProjection,
    DiscoveryWorkerLeaseRequest, DiscoveryWorkerObservationBatchRequest,
    DiscoveryWorkerReceiptOutcome,
};
use tauri::{AppHandle, Manager as _};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    adapter::FakeOutscraperAdapter,
    installation::load_or_create_worker_id,
    outscraper::{OutscraperClient, OutscraperError, OutscraperSubmission},
    protocol::{RelayWorkerProtocol, WorkerProtocol},
};
use crate::{app_state::AppState, discovery_credentials, relay};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const FAKE_STEP_DELAY: Duration = Duration::from_millis(250);
const OBSERVATION_BATCH_SIZE: usize = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostRunOutcome {
    NoCredential,
    Idle,
    LostLease,
    Failed,
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

pub(crate) fn start_production_local_worker(app: AppHandle) {
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
        let provider = match OutscraperClient::production() {
            Ok(provider) => provider,
            Err(error) => {
                eprintln!("buzz-desktop: Discovery source unavailable: {error}");
                return;
            }
        };

        loop {
            let state = app.state::<AppState>();
            if state.shutdown_started.load(Ordering::Acquire) {
                return;
            }
            let credential = match discovery_credentials::load_outscraper_credential() {
                Ok(Some(credential)) => credential,
                Ok(None) | Err(_) => {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
            };
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
            if let Err(error) =
                run_production_once_with_credential(&protocol, &provider, worker_id, &credential)
                    .await
            {
                eprintln!("buzz-desktop: Discovery run paused safely: {error}");
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, OutscraperError>> + Send + 'a>>;

trait BusinessDiscoveryProvider: Send + Sync {
    fn submit<'a>(
        &'a self,
        search: &'a buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec,
        credential: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, OutscraperSubmission>;

    fn poll<'a>(
        &'a self,
        request_id: &'a str,
        credential: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, Vec<buzz_core_pkg::discovery_worker::DiscoveryBusinessObservationInput>>;
}

impl BusinessDiscoveryProvider for OutscraperClient {
    fn submit<'a>(
        &'a self,
        search: &'a buzz_core_pkg::discovery::DiscoveryBusinessSearchSpec,
        credential: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, OutscraperSubmission> {
        Box::pin(OutscraperClient::submit(
            self,
            search,
            credential,
            cancellation,
        ))
    }

    fn poll<'a>(
        &'a self,
        request_id: &'a str,
        credential: &'a Zeroizing<String>,
        cancellation: &'a CancellationToken,
    ) -> ProviderFuture<'a, Vec<buzz_core_pkg::discovery_worker::DiscoveryBusinessObservationInput>>
    {
        Box::pin(OutscraperClient::poll_until_ready(
            self,
            request_id,
            credential,
            cancellation,
        ))
    }
}

async fn run_production_once_with_credential<P, D>(
    protocol: &P,
    provider: &D,
    worker_id: Uuid,
    credential: &Zeroizing<String>,
) -> Result<HostRunOutcome, String>
where
    P: WorkerProtocol,
    D: BusinessDiscoveryProvider,
{
    let claim = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id,
    };
    let mut lease = match protocol.claim(claim).await? {
        DiscoveryWorkerReceiptOutcome::Idle => return Ok(HostRunOutcome::Idle),
        DiscoveryWorkerReceiptOutcome::Lease(lease) => lease,
        _ => return Err("Discovery claim returned an invalid outcome".to_string()),
    };

    if matches!(
        lease.last_checkpoint.as_ref().map(|value| value.kind),
        Some(DiscoveryCheckpointKind::ProviderResultsReady)
    ) {
        return complete_current_lease(protocol, &mut lease).await;
    }

    let (provider_request_id, ready) = match lease.last_checkpoint.clone() {
        None => {
            let cancellation = CancellationToken::new();
            let business_search = lease.business_search.clone();
            let submission = match drive_provider_step(
                protocol,
                &mut lease,
                &cancellation,
                provider.submit(&business_search, credential, &cancellation),
            )
            .await?
            {
                ProviderStep::Value(value) => value,
                ProviderStep::LostLease => return Ok(HostRunOutcome::LostLease),
                ProviderStep::ProviderError => {
                    return fail_current_lease(protocol, &lease).await;
                }
            };
            let checkpoint = DiscoveryWorkerCheckpoint {
                sequence: 1,
                kind: DiscoveryCheckpointKind::ProviderSubmitted,
                provider: DiscoveryProvider::Outscraper,
                provider_request_id: Some(submission.request_id.clone()),
                item_count: None,
            };
            if !commit_checkpoint(protocol, &mut lease, checkpoint).await? {
                return Ok(HostRunOutcome::LostLease);
            }
            (submission.request_id, submission.ready)
        }
        Some(checkpoint)
            if checkpoint.kind == DiscoveryCheckpointKind::ProviderSubmitted
                && checkpoint.provider == DiscoveryProvider::Outscraper =>
        {
            let request_id = checkpoint
                .provider_request_id
                .ok_or_else(|| "Discovery provider checkpoint is incomplete".to_string())?;
            (request_id, None)
        }
        Some(_) => return Err("Discovery checkpoint cannot be resumed safely".to_string()),
    };

    let observations = if let Some(ready) = ready {
        ready
    } else {
        let cancellation = CancellationToken::new();
        match drive_provider_step(
            protocol,
            &mut lease,
            &cancellation,
            provider.poll(&provider_request_id, credential, &cancellation),
        )
        .await?
        {
            ProviderStep::Value(value) => value,
            ProviderStep::LostLease => return Ok(HostRunOutcome::LostLease),
            ProviderStep::ProviderError => {
                return fail_current_lease(protocol, &lease).await;
            }
        }
    };

    if observations.len() > 500 {
        return fail_current_lease(protocol, &lease).await;
    }

    for (batch_index, observations) in observations.chunks(OBSERVATION_BATCH_SIZE).enumerate() {
        let request = DiscoveryWorkerObservationBatchRequest {
            lease: lease_request(&lease),
            provider_request_id: provider_request_id.clone(),
            batch_index: u32::try_from(batch_index)
                .map_err(|_| "Discovery source returned too many batches".to_string())?,
            observations: observations.to_vec(),
        };
        match protocol.store_observations(request).await? {
            DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) => {
                lease = stored.lease;
            }
            DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                return Ok(HostRunOutcome::LostLease);
            }
            _ => return Err("Discovery observation write returned an invalid outcome".to_string()),
        }
    }

    let item_count = u32::try_from(observations.len())
        .map_err(|_| "Discovery source returned too many businesses".to_string())?;
    let results_ready = DiscoveryWorkerCheckpoint {
        sequence: 2,
        kind: DiscoveryCheckpointKind::ProviderResultsReady,
        provider: DiscoveryProvider::Outscraper,
        provider_request_id: None,
        item_count: Some(item_count),
    };
    if !commit_checkpoint(protocol, &mut lease, results_ready).await? {
        return Ok(HostRunOutcome::LostLease);
    }
    complete_current_lease(protocol, &mut lease).await
}

enum ProviderStep<T> {
    Value(T),
    LostLease,
    ProviderError,
}

async fn drive_provider_step<P, F, T>(
    protocol: &P,
    lease: &mut DiscoveryWorkerLeaseProjection,
    cancellation: &CancellationToken,
    future: F,
) -> Result<ProviderStep<T>, String>
where
    P: WorkerProtocol,
    F: Future<Output = Result<T, OutscraperError>>,
{
    match protocol.heartbeat(lease_request(lease)).await {
        Ok(DiscoveryWorkerReceiptOutcome::Lease(updated)) => *lease = updated,
        Ok(DiscoveryWorkerReceiptOutcome::LostLease(_)) => {
            cancellation.cancel();
            return Ok(ProviderStep::LostLease);
        }
        Ok(_) => {
            cancellation.cancel();
            return Err("Discovery heartbeat returned an invalid outcome".to_string());
        }
        Err(error) => {
            cancellation.cancel();
            return Err(error);
        }
    }
    tokio::pin!(future);
    loop {
        let interval = heartbeat_interval(lease);
        tokio::select! {
            result = &mut future => {
                return Ok(match result {
                    Ok(value) => ProviderStep::Value(value),
                    Err(_) => ProviderStep::ProviderError,
                });
            }
            () = tokio::time::sleep(interval) => {
                match protocol.heartbeat(lease_request(lease)).await {
                    Ok(DiscoveryWorkerReceiptOutcome::Lease(updated)) => *lease = updated,
                    Ok(DiscoveryWorkerReceiptOutcome::LostLease(_)) => {
                        cancellation.cancel();
                        return Ok(ProviderStep::LostLease);
                    }
                    Ok(_) => {
                        cancellation.cancel();
                        return Err("Discovery heartbeat returned an invalid outcome".to_string());
                    }
                    Err(error) => {
                        cancellation.cancel();
                        return Err(error);
                    }
                }
            }
        }
    }
}

async fn commit_checkpoint<P: WorkerProtocol>(
    protocol: &P,
    lease: &mut DiscoveryWorkerLeaseProjection,
    checkpoint: DiscoveryWorkerCheckpoint,
) -> Result<bool, String> {
    let request = DiscoveryWorkerCheckpointRequest {
        lease: lease_request(lease),
        checkpoint,
    };
    match protocol.checkpoint(request).await? {
        DiscoveryWorkerReceiptOutcome::Lease(updated) => {
            *lease = updated;
            Ok(true)
        }
        DiscoveryWorkerReceiptOutcome::LostLease(_) => Ok(false),
        _ => Err("Discovery checkpoint returned an invalid outcome".to_string()),
    }
}

async fn complete_current_lease<P: WorkerProtocol>(
    protocol: &P,
    lease: &mut DiscoveryWorkerLeaseProjection,
) -> Result<HostRunOutcome, String> {
    match protocol.complete(lease_request(lease)).await? {
        DiscoveryWorkerReceiptOutcome::Completed(_) => Ok(HostRunOutcome::Completed),
        DiscoveryWorkerReceiptOutcome::LostLease(_) => Ok(HostRunOutcome::LostLease),
        _ => Err("Discovery completion returned an invalid outcome".to_string()),
    }
}

async fn fail_current_lease<P: WorkerProtocol>(
    protocol: &P,
    lease: &DiscoveryWorkerLeaseProjection,
) -> Result<HostRunOutcome, String> {
    match protocol.fail(lease_request(lease)).await? {
        DiscoveryWorkerReceiptOutcome::Failed(_) => Ok(HostRunOutcome::Failed),
        DiscoveryWorkerReceiptOutcome::LostLease(_) => Ok(HostRunOutcome::LostLease),
        _ => Err("Discovery failure returned an invalid outcome".to_string()),
    }
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
    (remaining / 3).clamp(Duration::from_millis(50), Duration::from_secs(2))
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
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering as AtomicOrdering},
            Mutex,
        },
    };

    use buzz_core_pkg::{
        discovery::{DiscoveryBusinessSearchSpec, DiscoveryRunProjection, DiscoveryRunState},
        discovery_worker::{
            deterministic_business_observation_id, DiscoveryBusinessObservationInput,
            DiscoveryBusinessStatus, DiscoveryCheckpointKind, DiscoveryProvider,
            DiscoveryWorkerCheckpoint, DiscoveryWorkerStoredObservationsProjection,
        },
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

        fn store_observations(
            &self,
            _: DiscoveryWorkerObservationBatchRequest,
        ) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("store_observations") })
        }

        fn fail(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("fail") })
        }

        fn complete(&self, _: DiscoveryWorkerLeaseRequest) -> ProtocolFuture<'_> {
            Box::pin(async { self.next("complete") })
        }
    }

    struct FakeProvider {
        submit_calls: AtomicUsize,
        poll_calls: AtomicUsize,
        ready_on_submit: bool,
        wait_for_cancellation: bool,
        submit_error: Option<OutscraperError>,
        observations: Vec<DiscoveryBusinessObservationInput>,
    }

    impl FakeProvider {
        fn immediate(observations: Vec<DiscoveryBusinessObservationInput>) -> Self {
            Self {
                submit_calls: AtomicUsize::new(0),
                poll_calls: AtomicUsize::new(0),
                ready_on_submit: true,
                wait_for_cancellation: false,
                submit_error: None,
                observations,
            }
        }

        fn polled(observations: Vec<DiscoveryBusinessObservationInput>) -> Self {
            Self {
                submit_calls: AtomicUsize::new(0),
                poll_calls: AtomicUsize::new(0),
                ready_on_submit: false,
                wait_for_cancellation: false,
                submit_error: None,
                observations,
            }
        }

        fn pending_forever() -> Self {
            Self {
                submit_calls: AtomicUsize::new(0),
                poll_calls: AtomicUsize::new(0),
                ready_on_submit: false,
                wait_for_cancellation: true,
                submit_error: None,
                observations: Vec::new(),
            }
        }

        fn rejected() -> Self {
            Self {
                submit_calls: AtomicUsize::new(0),
                poll_calls: AtomicUsize::new(0),
                ready_on_submit: false,
                wait_for_cancellation: false,
                submit_error: Some(OutscraperError::CredentialRejected),
                observations: Vec::new(),
            }
        }
    }

    impl BusinessDiscoveryProvider for FakeProvider {
        fn submit<'a>(
            &'a self,
            _: &'a DiscoveryBusinessSearchSpec,
            _: &'a Zeroizing<String>,
            cancellation: &'a CancellationToken,
        ) -> ProviderFuture<'a, OutscraperSubmission> {
            self.submit_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Box::pin(async move {
                if self.wait_for_cancellation {
                    cancellation.cancelled().await;
                    return Err(OutscraperError::Cancelled);
                }
                if let Some(error) = self.submit_error {
                    return Err(error);
                }
                Ok(OutscraperSubmission {
                    request_id: "fixture-request".to_string(),
                    ready: self.ready_on_submit.then(|| self.observations.clone()),
                })
            })
        }

        fn poll<'a>(
            &'a self,
            _: &'a str,
            _: &'a Zeroizing<String>,
            cancellation: &'a CancellationToken,
        ) -> ProviderFuture<'a, Vec<DiscoveryBusinessObservationInput>> {
            self.poll_calls.fetch_add(1, AtomicOrdering::SeqCst);
            Box::pin(async move {
                if self.wait_for_cancellation {
                    cancellation.cancelled().await;
                    return Err(OutscraperError::Cancelled);
                }
                Ok(self.observations.clone())
            })
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
            business_search: DiscoveryBusinessSearchSpec {
                query: "dentists".to_owned(),
                location: "Sandton, Johannesburg, South Africa".to_owned(),
                limit: 3,
                language: "en".to_owned(),
                region: Some("ZA".to_owned()),
            },
            last_checkpoint,
        }
    }

    fn lease_outcome(value: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
        DiscoveryWorkerReceiptOutcome::Lease(value.clone())
    }

    fn observation(provider_record_id: &str) -> DiscoveryBusinessObservationInput {
        DiscoveryBusinessObservationInput {
            observation_id: deterministic_business_observation_id(provider_record_id),
            provider_record_id: provider_record_id.to_string(),
            place_id: Some(provider_record_id.to_string()),
            google_id: None,
            name: format!("Business {provider_record_id}"),
            website: None,
            phone: None,
            full_address: None,
            city: None,
            state: None,
            postal_code: None,
            country: None,
            country_code: None,
            latitude_micros: None,
            longitude_micros: None,
            category: None,
            subtypes: Vec::new(),
            rating_hundredths: None,
            reviews_count: None,
            business_status: Some(DiscoveryBusinessStatus::Operational),
            verified: None,
            source_url: None,
            image_url: None,
        }
    }

    fn stored_outcome(lease: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerReceiptOutcome {
        DiscoveryWorkerReceiptOutcome::ObservationsStored(
            DiscoveryWorkerStoredObservationsProjection {
                lease: lease.clone(),
                accepted_count: 1,
                existing_count: 0,
            },
        )
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
    async fn production_run_checkpoints_before_storing_and_completing() {
        let lease = lease(None);
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            lease_outcome(&lease),
            lease_outcome(&lease),
            stored_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
        ]);
        let provider = FakeProvider::immediate(vec![observation("place-one")]);
        let outcome = run_production_once_with_credential(
            &protocol,
            &provider,
            lease.worker_id,
            &Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("production run");
        assert_eq!(outcome, HostRunOutcome::Completed);
        assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            *protocol.calls.lock().expect("calls"),
            [
                "claim",
                "heartbeat",
                "checkpoint",
                "store_observations",
                "checkpoint",
                "complete"
            ]
        );
    }

    #[tokio::test]
    async fn production_resume_polls_existing_request_without_resubmitting() {
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
            stored_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
        ]);
        let provider = FakeProvider::polled(vec![observation("place-one")]);
        let outcome = run_production_once_with_credential(
            &protocol,
            &provider,
            lease.worker_id,
            &Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("resumed production run");
        assert_eq!(outcome, HostRunOutcome::Completed);
        assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn results_ready_resume_completes_with_zero_provider_traffic() {
        let ready = DiscoveryWorkerCheckpoint {
            sequence: 2,
            kind: DiscoveryCheckpointKind::ProviderResultsReady,
            provider: DiscoveryProvider::Outscraper,
            provider_request_id: None,
            item_count: Some(1),
        };
        let lease = lease(Some(ready));
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Completed(lease.run.clone()),
        ]);
        let provider = FakeProvider::polled(Vec::new());
        let outcome = run_production_once_with_credential(
            &protocol,
            &provider,
            lease.worker_id,
            &Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("results-ready resume");
        assert_eq!(outcome, HostRunOutcome::Completed);
        assert_eq!(provider.submit_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(provider.poll_calls.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(
            *protocol.calls.lock().expect("calls"),
            ["claim", "complete"]
        );
    }

    #[tokio::test]
    async fn lost_lease_cancels_an_inflight_provider_request() {
        let mut lease = lease(None);
        lease.lease_until = Utc::now() + chrono::Duration::milliseconds(120);
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::LostLease(lease.run.clone()),
        ]);
        let provider = FakeProvider::pending_forever();
        let outcome = run_production_once_with_credential(
            &protocol,
            &provider,
            lease.worker_id,
            &Zeroizing::new("fixture".to_string()),
        )
        .await
        .expect("lost lease");
        assert_eq!(outcome, HostRunOutcome::LostLease);
        assert_eq!(
            *protocol.calls.lock().expect("calls"),
            ["claim", "heartbeat"]
        );
    }

    #[tokio::test]
    async fn terminal_provider_error_fails_once_without_persisting_details() {
        let lease = lease(None);
        let mut failed_run = lease.run.clone();
        failed_run.state = DiscoveryRunState::Failed;
        failed_run.terminal_reason =
            Some(buzz_core_pkg::discovery::DiscoveryTerminalReason::ExecutorFailed);
        let protocol = FakeProtocol::new(vec![
            lease_outcome(&lease),
            lease_outcome(&lease),
            DiscoveryWorkerReceiptOutcome::Failed(failed_run),
        ]);
        let provider = FakeProvider::rejected();
        let outcome = run_production_once_with_credential(
            &protocol,
            &provider,
            lease.worker_id,
            &Zeroizing::new("fixture-secret".to_string()),
        )
        .await
        .expect("terminal provider failure");
        assert_eq!(outcome, HostRunOutcome::Failed);
        assert_eq!(
            *protocol.calls.lock().expect("calls"),
            ["claim", "heartbeat", "fail"]
        );
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

    #[ignore = "requires isolated Postgres, Redis, and relay with external workers enabled"]
    #[tokio::test]
    async fn native_host_real_relay_completes_and_recovers_after_restart() {
        use buzz_core_pkg::discovery::{DiscoveryBusinessSearchSpec, DiscoveryStartRequest};
        use buzz_sdk_pkg::discovery::build_discovery_start_action;
        use sqlx::Row as _;

        const FIXTURE_SECRET: &str = "native-host-secret-never-crosses-relay";
        let relay_url =
            std::env::var("RELAY_URL").unwrap_or_else(|_| "ws://localhost:3030".to_string());
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://buzz:buzz_dev@localhost:5471/buzz".to_string());
        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect isolated Postgres");
        let host = buzz_core_pkg::tenant::relay_url_authority(&relay_url);
        let community_id: Uuid =
            sqlx::query("SELECT id FROM communities WHERE lower(host)=lower($1)")
                .bind(&host)
                .fetch_one(&pool)
                .await
                .expect("isolated community")
                .try_get("id")
                .expect("community id");
        let actor = nostr::Keys::generate();
        let actor_bytes = actor.public_key().to_bytes();
        let actor_hex = actor.public_key().to_hex();
        sqlx::query(
            "INSERT INTO users (community_id,pubkey,display_name) \
             VALUES ($1,$2,'Native Discovery Host') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
        )
        .bind(community_id)
        .bind(actor_bytes.as_slice())
        .execute(&pool)
        .await
        .expect("provision native host user");
        sqlx::query(
            "INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member') \
             ON CONFLICT (community_id,pubkey) DO NOTHING",
        )
        .bind(community_id)
        .bind(&actor_hex)
        .execute(&pool)
        .await
        .expect("provision native host member");
        sqlx::query(
            "INSERT INTO discovery_entitlements (community_id,active,updated_at) \
             VALUES ($1,TRUE,now()) ON CONFLICT (community_id) \
             DO UPDATE SET active=TRUE,updated_at=now()",
        )
        .bind(community_id)
        .execute(&pool)
        .await
        .expect("enable Discovery entitlement");

        let state = crate::app_state::build_app_state();
        *state.keys.lock().expect("state keys") = actor.clone();
        *state.relay_url_override.lock().expect("workspace relay") = Some(relay_url.clone());
        crate::discovery_worker::workspace_changed();
        let generation = crate::discovery_worker::workspace_generation();
        let api_base_url = relay::relay_http_base_url(&relay_url);
        let relay_pubkey = super::super::protocol::fetch_relay_pubkey(&state, &api_base_url)
            .await
            .expect("relay signing identity");
        let worker_id = Uuid::new_v4();

        let actions_before: i64 =
            sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40017")
                .bind(community_id)
                .fetch_one(&pool)
                .await
                .expect("count worker actions before missing credential");
        let no_credential_protocol = RelayWorkerProtocol::connect(
            &state,
            actor.clone(),
            api_base_url.clone(),
            worker_id,
            generation,
        )
        .await
        .expect("missing-credential protocol");
        assert_eq!(
            run_once_with_loader(&no_credential_protocol, worker_id, Duration::ZERO, || Ok(
                None
            ),)
            .await
            .expect("missing credential outcome"),
            HostRunOutcome::NoCredential
        );
        let actions_after: i64 =
            sqlx::query_scalar("SELECT count(*) FROM events WHERE community_id=$1 AND kind=40017")
                .bind(community_id)
                .fetch_one(&pool)
                .await
                .expect("count worker actions after missing credential");
        assert_eq!(actions_before, actions_after);

        async fn start_run(
            state: &AppState,
            actor: &nostr::Keys,
            relay_pubkey: nostr::PublicKey,
            api_base_url: &str,
        ) -> Uuid {
            let request = DiscoveryStartRequest {
                request_id: Uuid::new_v4(),
                idempotency_key: Uuid::new_v4(),
                campaign_id: Uuid::new_v4(),
                business_search: DiscoveryBusinessSearchSpec {
                    query: "dentists".to_owned(),
                    location: "Sandton, Johannesburg, South Africa".to_owned(),
                    limit: 3,
                    language: "en".to_owned(),
                    region: Some("ZA".to_owned()),
                },
            };
            let response = relay::submit_event_at_with_keys(
                build_discovery_start_action(relay_pubkey, &request)
                    .expect("Discovery start builder"),
                state,
                api_base_url,
                actor,
            )
            .await
            .expect("start Discovery run");
            let message: serde_json::Value =
                serde_json::from_str(&response.message).expect("start response");
            Uuid::parse_str(
                message
                    .get("run")
                    .and_then(|run| run.get("run_id"))
                    .and_then(serde_json::Value::as_str)
                    .expect("started run id"),
            )
            .expect("valid started run id")
        }

        let first_run = start_run(&state, &actor, relay_pubkey, &api_base_url).await;
        let first_protocol = RelayWorkerProtocol::connect(
            &state,
            actor.clone(),
            api_base_url.clone(),
            worker_id,
            generation,
        )
        .await
        .expect("first native host protocol");
        let mut first_host = Box::pin(run_once_with_credential(
            &first_protocol,
            worker_id,
            Duration::from_secs(2),
            Zeroizing::new(FIXTURE_SECRET.to_string()),
        ));
        loop {
            tokio::select! {
                result = &mut first_host => panic!("first host exited before restart point: {result:?}"),
                () = tokio::time::sleep(Duration::from_millis(50)) => {
                    let submitted: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM discovery_run_checkpoints \
                         WHERE community_id=$1 AND run_id=$2 AND sequence=1",
                    )
                    .bind(community_id)
                    .bind(first_run)
                    .fetch_one(&pool)
                    .await
                    .expect("poll provider-submitted checkpoint");
                    if submitted == 1 {
                        break;
                    }
                }
            }
        }
        drop(first_host);
        tokio::time::sleep(Duration::from_secs(6)).await;

        let restarted_protocol = RelayWorkerProtocol::connect(
            &state,
            actor.clone(),
            api_base_url.clone(),
            worker_id,
            generation,
        )
        .await
        .expect("restarted native host protocol");
        assert_eq!(
            run_once_with_credential(
                &restarted_protocol,
                worker_id,
                Duration::ZERO,
                Zeroizing::new(FIXTURE_SECRET.to_string()),
            )
            .await
            .expect("restarted native host outcome"),
            HostRunOutcome::Completed
        );
        let run_row = sqlx::query(
            "SELECT state,attempt,completed_steps FROM discovery_runs \
             WHERE community_id=$1 AND id=$2",
        )
        .bind(community_id)
        .bind(first_run)
        .fetch_one(&pool)
        .await
        .expect("completed native run");
        assert_eq!(run_row.get::<String, _>("state"), "succeeded");
        assert_eq!(run_row.get::<i32, _>("attempt"), 2);
        assert_eq!(run_row.get::<i32, _>("completed_steps"), 1);
        let checkpoints: Vec<i32> = sqlx::query_scalar(
            "SELECT sequence FROM discovery_run_checkpoints \
             WHERE community_id=$1 AND run_id=$2 ORDER BY sequence",
        )
        .bind(community_id)
        .bind(first_run)
        .fetch_all(&pool)
        .await
        .expect("native checkpoints");
        assert_eq!(checkpoints, vec![1, 2]);
        let leaked_events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE community_id=$1 AND content LIKE '%' || $2 || '%'",
        )
        .bind(community_id)
        .bind(FIXTURE_SECRET)
        .fetch_one(&pool)
        .await
        .expect("scan native event contents");
        let leaked_checkpoints: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM discovery_run_checkpoints WHERE community_id=$1 \
             AND coalesce(provider_request_id,'') LIKE '%' || $2 || '%'",
        )
        .bind(community_id)
        .bind(FIXTURE_SECRET)
        .fetch_one(&pool)
        .await
        .expect("scan native checkpoints");
        assert_eq!((leaked_events, leaked_checkpoints), (0, 0));
    }
}
