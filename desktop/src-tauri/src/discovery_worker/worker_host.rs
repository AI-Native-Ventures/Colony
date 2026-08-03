use std::{
    sync::atomic::Ordering,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::{future::Future, pin::Pin};

#[cfg(test)]
use buzz_core_pkg::discovery_worker::{
    DiscoveryCheckpointKind, DiscoveryWorkerCheckpoint, DiscoveryWorkerObservationBatchRequest,
    DiscoveryWorkerSalvagedObservationsProjection,
};
use buzz_core_pkg::discovery_worker::{
    DiscoveryProvider, DiscoveryWorkerCheckpointRequest, DiscoveryWorkerClaimRequest,
    DiscoveryWorkerLeaseProjection, DiscoveryWorkerLeaseRequest, DiscoveryWorkerReceiptOutcome,
    DiscoveryWorkerSalvageBatchRequest,
};
use tauri::{AppHandle, Manager as _};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::outscraper::OutscraperPollOutcome;
#[cfg(test)]
use super::outscraper::{OutscraperClient, OutscraperError, OutscraperSubmission};
use super::{
    adapter::FakeOutscraperAdapter,
    installation::load_or_create_worker_id,
    outbox::DiscoveryOutbox,
    protocol::{RelayWorkerProtocol, WorkerProtocol},
    provider_context::{LocalProviderCredentials, ProductionProviderClients},
    source_executor::{execute_production_source_plan, CoordinatedRunOutcome},
};
use crate::{app_state::AppState, discovery_credentials, relay};

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const FAKE_STEP_DELAY: Duration = Duration::from_millis(250);
#[cfg(test)]
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
        let providers = match ProductionProviderClients::new() {
            Ok(providers) => providers,
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
            let outbox =
                match DiscoveryOutbox::open(&app_data_dir, &relay_url, &keys.public_key().to_hex())
                {
                    Ok(outbox) => outbox,
                    Err(error) => {
                        eprintln!("buzz-desktop: Discovery recovery unavailable: {error}");
                        tokio::time::sleep(POLL_INTERVAL).await;
                        continue;
                    }
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
            if let Err(error) = reconcile_terminal_outbox(&protocol, &outbox, worker_id).await {
                eprintln!("buzz-desktop: Discovery recovery paused safely: {error}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            let credentials = match LocalProviderCredentials::load() {
                Ok(credentials) => credentials,
                Err(_) => {
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                }
            };
            if let Err(error) = recover_terminal_outscraper_submissions(
                &protocol,
                &providers,
                &credentials,
                &outbox,
                worker_id,
            )
            .await
            {
                eprintln!("buzz-desktop: Discovery paid-result polling paused safely: {error}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            let available_providers = credentials.available_providers();
            if available_providers.is_empty() {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            if let Err(error) = run_multi_source_production_once(
                &protocol,
                &providers,
                &credentials,
                &outbox,
                worker_id,
                available_providers,
            )
            .await
            {
                eprintln!("buzz-desktop: Discovery run paused safely: {error}");
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

async fn run_multi_source_production_once<P: WorkerProtocol>(
    protocol: &P,
    providers: &ProductionProviderClients,
    credentials: &LocalProviderCredentials,
    outbox: &DiscoveryOutbox,
    worker_id: Uuid,
    available_providers: Vec<DiscoveryProvider>,
) -> Result<HostRunOutcome, String> {
    let claim = DiscoveryWorkerClaimRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id,
        available_providers,
    };
    let lease = match protocol.claim(claim).await? {
        DiscoveryWorkerReceiptOutcome::Idle => return Ok(HostRunOutcome::Idle),
        DiscoveryWorkerReceiptOutcome::Lease(lease) => lease,
        _ => return Err("Discovery claim returned an invalid outcome".to_owned()),
    };
    match execute_production_source_plan(protocol, providers, credentials, outbox, lease).await? {
        CoordinatedRunOutcome::Complete(mut lease) => {
            complete_current_lease(protocol, &mut lease).await
        }
        CoordinatedRunOutcome::Fail(lease) => fail_current_lease(protocol, &lease).await,
        CoordinatedRunOutcome::LostLease => Ok(HostRunOutcome::LostLease),
    }
}

async fn recover_terminal_outscraper_submissions<P: WorkerProtocol>(
    protocol: &P,
    providers: &ProductionProviderClients,
    credentials: &LocalProviderCredentials,
    outbox: &DiscoveryOutbox,
    worker_id: Uuid,
) -> Result<(), String> {
    let Some(credential) = credentials.credential(DiscoveryProvider::Outscraper) else {
        return Ok(());
    };
    let mut recovered_results = false;
    for run_id in outbox.run_ids()? {
        let Some(call) = outbox.call_for(run_id, DiscoveryProvider::Outscraper) else {
            continue;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let Some(provider_request_id) = outbox.submitted_recovery_due(call.call_id, now)? else {
            continue;
        };
        let Ok(run) = protocol.status(run_id).await else {
            // Status is also the entitlement and ownership gate. A suspended or
            // disconnected workspace must not touch the provider.
            continue;
        };
        if !run.state.is_terminal() {
            continue;
        }
        let cancellation = CancellationToken::new();
        let poll = providers
            .outscraper
            .poll_once_with_preflight(
                &provider_request_id,
                credential,
                || async {
                    protocol
                        .status(run_id)
                        .await
                        .is_ok_and(|current| current.state.is_terminal())
                },
                &cancellation,
            )
            .await;
        let observations = match poll {
            Ok(OutscraperPollOutcome::Ready(observations)) => observations,
            Ok(OutscraperPollOutcome::Pending) | Err(_) => {
                // This is already-paid recovery, not a prerequisite for new
                // work. Preserve it for a later retry without starving other
                // providers or campaigns.
                outbox.defer_submitted_recovery(call.call_id, now)?;
                continue;
            }
        };
        outbox.record_results(call.call_id, Some(provider_request_id), 1, observations)?;
        recovered_results = true;
    }
    if recovered_results {
        reconcile_terminal_outbox(protocol, outbox, worker_id).await
    } else {
        Ok(())
    }
}

async fn reconcile_terminal_outbox<P: WorkerProtocol>(
    protocol: &P,
    outbox: &DiscoveryOutbox,
    worker_id: Uuid,
) -> Result<(), String> {
    for run_id in outbox.run_ids()? {
        if let Ok(run) = protocol.status(run_id).await {
            if run.state.is_terminal() {
                for provider in [
                    DiscoveryProvider::Outscraper,
                    DiscoveryProvider::BraveSearch,
                    DiscoveryProvider::ExaSearch,
                ] {
                    let Some(call) = outbox.call_for(run_id, provider) else {
                        continue;
                    };
                    let mut salvage_blocked = false;
                    while let Some(batch) = outbox.next_batch(call.call_id)? {
                        let request = DiscoveryWorkerSalvageBatchRequest {
                            request_id: batch.request_id,
                            idempotency_key: batch.idempotency_key,
                            worker_id,
                            run_id,
                            provider: batch.provider,
                            provider_request_id: batch.provider_request_id,
                            batch_index: batch.batch_index,
                            observations: batch.observations,
                        };
                        match protocol.salvage_observations(request).await {
                            Err(_) => {
                                salvage_blocked = true;
                                break;
                            }
                            Ok(DiscoveryWorkerReceiptOutcome::ObservationsSalvaged(salvaged))
                                if salvaged.run.run_id == run_id =>
                            {
                                outbox.acknowledge_batch(call.call_id, batch.batch_index)?;
                            }
                            _ => {
                                salvage_blocked = true;
                                break;
                            }
                        }
                    }
                    if !salvage_blocked
                        && outbox
                            .ready_metadata(call.call_id)?
                            .is_some_and(|metadata| metadata.response_complete)
                    {
                        outbox.remove_after_relay_ack(call.call_id)?;
                    }
                }
                outbox.remove_terminal_run(run_id)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, OutscraperError>> + Send + 'a>>;

#[cfg(test)]
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

#[cfg(test)]
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

#[cfg(test)]
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
        available_providers: vec![DiscoveryProvider::Outscraper],
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
            provider: DiscoveryProvider::Outscraper,
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

#[cfg(test)]
enum ProviderStep<T> {
    Value(T),
    LostLease,
    ProviderError,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutboxDrainOutcome {
    Drained,
    LostLease,
}

#[cfg(test)]
async fn drain_synchronous_outbox<P: WorkerProtocol>(
    protocol: &P,
    outbox: &DiscoveryOutbox,
    call_id: Uuid,
    lease: &mut DiscoveryWorkerLeaseProjection,
) -> Result<OutboxDrainOutcome, String> {
    loop {
        let Some(batch) = outbox.next_batch(call_id)? else {
            return Ok(OutboxDrainOutcome::Drained);
        };
        if batch.run_id != lease.run.run_id {
            return Err("Discovery outbox does not belong to the current run".to_owned());
        }
        let request = DiscoveryWorkerObservationBatchRequest {
            lease: DiscoveryWorkerLeaseRequest {
                request_id: batch.request_id,
                idempotency_key: batch.idempotency_key,
                worker_id: lease.worker_id,
                run_id: lease.run.run_id,
                lease_id: lease.lease_id,
            },
            provider: batch.provider,
            provider_request_id: batch.provider_request_id,
            batch_index: batch.batch_index,
            observations: batch.observations,
        };
        request
            .validate()
            .map_err(|_| "Discovery outbox batch is invalid".to_owned())?;
        match protocol.store_observations(request).await? {
            DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) => {
                *lease = stored.lease;
                outbox.acknowledge_batch(call_id, batch.batch_index)?;
            }
            DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                return Ok(OutboxDrainOutcome::LostLease);
            }
            _ => return Err("Discovery observation write returned an invalid outcome".to_owned()),
        }
    }
}

#[cfg(test)]
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

#[cfg(test)]
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
        discovery_credentials::load_discovery_credential(
            discovery_credentials::DiscoveryCredentialProvider::Outscraper,
        )
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
        available_providers: vec![DiscoveryProvider::Outscraper],
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
#[path = "worker_host_tests.rs"]
mod tests;
