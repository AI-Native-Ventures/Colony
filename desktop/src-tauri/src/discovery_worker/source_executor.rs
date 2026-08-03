use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use buzz_core_pkg::{
    discovery::{DiscoveryProvider, DiscoverySource},
    discovery_worker::{
        DiscoveryCheckpointKind, DiscoveryRunSourceFailureClass, DiscoveryRunSourceProjection,
        DiscoveryRunSourceStatus, DiscoveryWorkerCheckpoint, DiscoveryWorkerCheckpointRequest,
        DiscoveryWorkerLeaseProjection, DiscoveryWorkerLeaseRequest,
        DiscoveryWorkerObservationBatchRequest, DiscoveryWorkerReceiptOutcome,
        DiscoveryWorkerSourceProgressRequest,
    },
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{
    brave::BraveSearchClient,
    coordinator::{
        execute_source_plan, PlanExecution, SourceExecution, SourceExecutor, SourceFuture,
    },
    exa::ExaSearchClient,
    outbox::{DiscoveryOutbox, SynchronousCallState},
    outscraper::{OutscraperClient, OutscraperError},
    protocol::WorkerProtocol,
    source_errors::{
        brave_failure, brave_is_uncertain, exa_failure, exa_is_uncertain, outscraper_failure,
    },
};
use crate::discovery_credentials::{self, DiscoveryCredentialProvider};

const OBSERVATION_BATCH_SIZE: usize = 25;

pub(super) struct ProductionProviderClients {
    outscraper: OutscraperClient,
    brave: BraveSearchClient,
    exa: ExaSearchClient,
}

impl ProductionProviderClients {
    pub(super) fn new() -> Result<Self, String> {
        Ok(Self {
            outscraper: OutscraperClient::production().map_err(|error| error.to_string())?,
            brave: BraveSearchClient::production().map_err(|error| error.to_string())?,
            exa: ExaSearchClient::production().map_err(|error| error.to_string())?,
        })
    }
}

pub(super) struct LocalProviderCredentials {
    outscraper: Option<Zeroizing<String>>,
    brave: Option<Zeroizing<String>>,
    exa: Option<Zeroizing<String>>,
}

impl LocalProviderCredentials {
    pub(super) fn load() -> Result<Self, String> {
        Ok(Self {
            outscraper: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::Outscraper,
            )?,
            brave: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::BraveSearch,
            )?,
            exa: discovery_credentials::load_discovery_credential(
                DiscoveryCredentialProvider::ExaSearch,
            )?,
        })
    }

    pub(super) fn available_providers(&self) -> Vec<DiscoveryProvider> {
        [
            (DiscoveryProvider::Outscraper, self.outscraper.is_some()),
            (DiscoveryProvider::BraveSearch, self.brave.is_some()),
            (DiscoveryProvider::ExaSearch, self.exa.is_some()),
        ]
        .into_iter()
        .filter_map(|(provider, available)| available.then_some(provider))
        .collect()
    }

    fn credential(&self, provider: DiscoveryProvider) -> Option<&Zeroizing<String>> {
        match provider {
            DiscoveryProvider::Outscraper => self.outscraper.as_ref(),
            DiscoveryProvider::BraveSearch => self.brave.as_ref(),
            DiscoveryProvider::ExaSearch => self.exa.as_ref(),
        }
    }
}

pub(super) enum CoordinatedRunOutcome {
    Complete(DiscoveryWorkerLeaseProjection),
    Fail(DiscoveryWorkerLeaseProjection),
    LostLease,
}

pub(super) async fn execute_production_source_plan<P: WorkerProtocol>(
    protocol: &P,
    clients: &ProductionProviderClients,
    credentials: &LocalProviderCredentials,
    outbox: &DiscoveryOutbox,
    lease: DiscoveryWorkerLeaseProjection,
) -> Result<CoordinatedRunOutcome, String> {
    let initial_retained = lease
        .source_states
        .iter()
        .map(|state| state.retained_count)
        .sum::<u32>();
    let target = u32::from(lease.business_search.limit);
    let executor = ProductionSourceExecutor {
        protocol,
        clients,
        credentials,
        outbox,
        lease: Mutex::new(lease),
        checkpoint_lock: Mutex::new(()),
        cancellation: CancellationToken::new(),
        retained: AtomicU32::new(initial_retained),
        target,
    };
    let config = executor.lease.lock().await.source_config.clone();
    let plan = execute_source_plan(&executor, &config, target, initial_retained);
    let heartbeat = executor.heartbeat_loop();
    tokio::pin!(plan);
    tokio::pin!(heartbeat);
    let outcome = tokio::select! {
        result = &mut plan => result?,
        result = &mut heartbeat => {
            executor.cancellation.cancel();
            return result.map(|()| CoordinatedRunOutcome::LostLease);
        }
    };
    executor.cancellation.cancel();
    let lease = executor.lease.lock().await.clone();
    Ok(match outcome {
        PlanExecution::Completed { .. } => CoordinatedRunOutcome::Complete(lease),
        PlanExecution::Failed => CoordinatedRunOutcome::Fail(lease),
        PlanExecution::LostLease | PlanExecution::Cancelled => CoordinatedRunOutcome::LostLease,
    })
}

struct ProductionSourceExecutor<'a, P> {
    protocol: &'a P,
    clients: &'a ProductionProviderClients,
    credentials: &'a LocalProviderCredentials,
    outbox: &'a DiscoveryOutbox,
    lease: Mutex<DiscoveryWorkerLeaseProjection>,
    checkpoint_lock: Mutex<()>,
    cancellation: CancellationToken,
    retained: AtomicU32,
    target: u32,
}

impl<P: WorkerProtocol> SourceExecutor for ProductionSourceExecutor<'_, P> {
    fn execute(&self, source: DiscoverySource, remaining_target: u32) -> SourceFuture<'_> {
        Box::pin(self.execute_source(source, remaining_target))
    }

    fn skip_target_met(&self, source: DiscoverySource) -> SourceFuture<'_> {
        Box::pin(self.skip_source(source))
    }
}

impl<P: WorkerProtocol> ProductionSourceExecutor<'_, P> {
    async fn execute_source(
        &self,
        source: DiscoverySource,
        remaining_target: u32,
    ) -> Result<SourceExecution, String> {
        let provider = source.provider();
        let state = self.source_state(provider).await?;
        if let Some(terminal) = terminal_source_execution(&state) {
            self.remove_terminal_outbox_if_present(&state).await?;
            return Ok(terminal);
        }
        if !self.heartbeat_once().await? {
            return Ok(SourceExecution::LostLease);
        }
        let fresh = state.status == DiscoveryRunSourceStatus::Pending;
        if fresh
            && !self
                .source_progress(provider, DiscoveryRunSourceStatus::Active, None, 0, 0, None)
                .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        match provider {
            DiscoveryProvider::Outscraper => self.execute_outscraper(remaining_target).await,
            DiscoveryProvider::BraveSearch => self.execute_brave(remaining_target, fresh).await,
            DiscoveryProvider::ExaSearch => self.execute_exa(remaining_target, fresh).await,
        }
    }

    async fn skip_source(&self, source: DiscoverySource) -> Result<SourceExecution, String> {
        let state = self.source_state(source.provider()).await?;
        if let Some(terminal) = terminal_source_execution(&state) {
            self.remove_terminal_outbox_if_present(&state).await?;
            return Ok(terminal);
        }
        if state.status == DiscoveryRunSourceStatus::Active {
            return self.execute_source(source, 0).await;
        }
        if !self
            .source_progress(
                source.provider(),
                DiscoveryRunSourceStatus::SkippedTargetMet,
                None,
                0,
                0,
                None,
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        Ok(SourceExecution::Succeeded { retained: 0 })
    }

    async fn execute_brave(
        &self,
        remaining_target: u32,
        fresh: bool,
    ) -> Result<SourceExecution, String> {
        let provider = DiscoveryProvider::BraveSearch;
        if !fresh {
            if let Some(recovered) = self.recover_synchronous(provider).await? {
                return Ok(recovered);
            }
        }
        let run_id = self.lease.lock().await.run.run_id;
        let intent = self.outbox.begin_call(run_id, provider)?;
        let credential = self
            .credentials
            .credential(provider)
            .ok_or_else(|| "configured Brave Search credential disappeared".to_owned())?;
        let search = self.lease.lock().await.business_search.clone();
        let outcome = self
            .clients
            .brave
            .search_with_remaining(
                &search,
                credential,
                || usize::try_from(self.dynamic_remaining(remaining_target)).unwrap_or(usize::MAX),
                &self.cancellation,
            )
            .await;
        match outcome {
            Ok(outcome) => {
                self.outbox.record_results(
                    intent.call_id,
                    None,
                    outcome.request_count,
                    outcome.observations,
                )?;
                self.finish_synchronous(intent.call_id, provider).await
            }
            Err(error) => {
                self.finish_synchronous_error(
                    intent.call_id,
                    provider,
                    brave_failure(error),
                    brave_is_uncertain(error),
                )
                .await
            }
        }
    }

    async fn execute_exa(
        &self,
        remaining_target: u32,
        fresh: bool,
    ) -> Result<SourceExecution, String> {
        let provider = DiscoveryProvider::ExaSearch;
        if !fresh {
            if let Some(recovered) = self.recover_synchronous(provider).await? {
                return Ok(recovered);
            }
        }
        let run_id = self.lease.lock().await.run.run_id;
        let intent = self.outbox.begin_call(run_id, provider)?;
        let credential = self
            .credentials
            .credential(provider)
            .ok_or_else(|| "configured Exa Search credential disappeared".to_owned())?;
        let search = self.lease.lock().await.business_search.clone();
        let remaining = self.dynamic_remaining(remaining_target);
        let outcome = self
            .clients
            .exa
            .search(
                &search,
                credential,
                usize::try_from(remaining).unwrap_or(usize::MAX),
                &self.cancellation,
            )
            .await;
        match outcome {
            Ok(outcome) => {
                self.outbox.record_results(
                    intent.call_id,
                    outcome.request_id,
                    outcome.request_count,
                    outcome.observations,
                )?;
                self.finish_synchronous(intent.call_id, provider).await
            }
            Err(error) => {
                self.finish_synchronous_error(
                    intent.call_id,
                    provider,
                    exa_failure(error),
                    exa_is_uncertain(error),
                )
                .await
            }
        }
    }

    async fn recover_synchronous(
        &self,
        provider: DiscoveryProvider,
    ) -> Result<Option<SourceExecution>, String> {
        let run_id = self.lease.lock().await.run.run_id;
        let Some(call) = self.outbox.call_for(run_id, provider) else {
            let state = self.source_state(provider).await?;
            if state.status == DiscoveryRunSourceStatus::Active {
                let retained = self
                    .mark_synchronous_outcome_unknown(None, provider, state.request_count.max(1))
                    .await?;
                return Ok(Some(retained));
            }
            return Ok(None);
        };
        match self.outbox.state_for(run_id, provider) {
            Some(SynchronousCallState::Ready) => self
                .finish_synchronous(call.call_id, provider)
                .await
                .map(Some),
            Some(SynchronousCallState::Intent) => {
                self.outbox.mark_outcome_unknown(call.call_id)?;
                self.mark_synchronous_outcome_unknown(Some(call.call_id), provider, 1)
                    .await
                    .map(Some)
            }
            Some(SynchronousCallState::OutcomeUnknown) => self
                .mark_synchronous_outcome_unknown(Some(call.call_id), provider, 1)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    async fn finish_synchronous(
        &self,
        call_id: Uuid,
        provider: DiscoveryProvider,
    ) -> Result<SourceExecution, String> {
        let before = self.source_state(provider).await?.retained_count;
        let metadata = self
            .outbox
            .ready_metadata(call_id)?
            .ok_or_else(|| "Discovery synchronous results are not recoverable".to_owned())?;
        if metadata.request_count == 0 {
            if !self
                .source_progress(
                    provider,
                    DiscoveryRunSourceStatus::SkippedTargetMet,
                    None,
                    0,
                    0,
                    None,
                )
                .await?
            {
                return Ok(SourceExecution::LostLease);
            }
            self.outbox.remove_after_relay_ack(call_id)?;
            return Ok(SourceExecution::Succeeded { retained: 0 });
        }
        if !self
            .ensure_submitted(provider, &metadata.provider_request_id)
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        if !self.drain_outbox(call_id).await? {
            return Ok(SourceExecution::LostLease);
        }
        if !self
            .checkpoint(
                DiscoveryCheckpointKind::ProviderResultsReady,
                provider,
                None,
                Some(metadata.item_count),
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        let status = if metadata.item_count == 0 {
            DiscoveryRunSourceStatus::Exhausted
        } else {
            DiscoveryRunSourceStatus::Completed
        };
        if !self
            .source_progress(
                provider,
                status,
                Some(metadata.provider_request_id.clone()),
                u32::from(metadata.request_count),
                metadata.item_count,
                None,
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        self.outbox.remove_after_relay_ack(call_id)?;
        let after = self.source_state(provider).await?.retained_count;
        let retained = after.saturating_sub(before);
        self.retained.fetch_add(retained, Ordering::AcqRel);
        Ok(SourceExecution::Succeeded { retained })
    }

    async fn finish_synchronous_error(
        &self,
        call_id: Uuid,
        provider: DiscoveryProvider,
        failure: DiscoveryRunSourceFailureClass,
        uncertain: bool,
    ) -> Result<SourceExecution, String> {
        if self.cancellation.is_cancelled() {
            return Ok(SourceExecution::LostLease);
        }
        if uncertain {
            self.outbox.mark_outcome_unknown(call_id)?;
            return self
                .mark_synchronous_outcome_unknown(Some(call_id), provider, 1)
                .await;
        }
        if !self
            .source_progress(
                provider,
                DiscoveryRunSourceStatus::Failed,
                None,
                1,
                0,
                Some(failure),
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        self.outbox.remove_after_relay_ack(call_id)?;
        Ok(SourceExecution::Failed { retained: 0 })
    }

    async fn mark_synchronous_outcome_unknown(
        &self,
        call_id: Option<Uuid>,
        provider: DiscoveryProvider,
        request_count: u32,
    ) -> Result<SourceExecution, String> {
        if !self
            .source_progress(
                provider,
                DiscoveryRunSourceStatus::OutcomeUnknown,
                None,
                request_count.max(1),
                0,
                Some(DiscoveryRunSourceFailureClass::OutcomeUnknown),
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        if let Some(call_id) = call_id {
            self.outbox.remove_after_relay_ack(call_id)?;
        }
        Ok(SourceExecution::Failed { retained: 0 })
    }

    async fn execute_outscraper(&self, _: u32) -> Result<SourceExecution, String> {
        let provider = DiscoveryProvider::Outscraper;
        let credential = self
            .credentials
            .credential(provider)
            .ok_or_else(|| "configured Outscraper credential disappeared".to_owned())?;
        let mut state = self.source_state(provider).await?;
        let search = self.lease.lock().await.business_search.clone();
        let recovered_checkpoint = self
            .lease
            .lock()
            .await
            .last_checkpoint
            .clone()
            .filter(|checkpoint| {
                checkpoint.kind == DiscoveryCheckpointKind::ProviderSubmitted
                    && checkpoint.provider == provider
            })
            .and_then(|checkpoint| checkpoint.provider_request_id);
        let (provider_request_id, ready) = if let Some(cursor) = state.request_cursor.clone() {
            (cursor, None)
        } else if let Some(provider_request_id) = recovered_checkpoint {
            (provider_request_id, None)
        } else {
            let submission = match self
                .clients
                .outscraper
                .submit(&search, credential, &self.cancellation)
                .await
            {
                Ok(submission) => submission,
                Err(error) => return self.finish_outscraper_submit_error(error).await,
            };
            if !self
                .ensure_submitted(provider, &submission.request_id)
                .await?
            {
                return Ok(SourceExecution::LostLease);
            }
            state = self.source_state(provider).await?;
            (submission.request_id, submission.ready)
        };
        let observations = if let Some(ready) = ready {
            ready
        } else {
            match self
                .clients
                .outscraper
                .poll_until_ready(&provider_request_id, credential, &self.cancellation)
                .await
            {
                Ok(observations) => observations,
                Err(error) => return self.finish_outscraper_poll_error(error, &state).await,
            }
        };
        if observations.len() > 500 {
            return self
                .finish_source_failure(
                    provider,
                    state.request_cursor,
                    state.request_count.max(1),
                    DiscoveryRunSourceFailureClass::ResponseTooLarge,
                )
                .await;
        }
        let before = state.retained_count;
        if !self
            .store_observations(provider, &provider_request_id, observations.clone())
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        let item_count = u32::try_from(observations.len())
            .map_err(|_| "Outscraper returned too many businesses".to_owned())?;
        if !self
            .checkpoint(
                DiscoveryCheckpointKind::ProviderResultsReady,
                provider,
                None,
                Some(item_count),
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        let status = if item_count == 0 {
            DiscoveryRunSourceStatus::Exhausted
        } else {
            DiscoveryRunSourceStatus::Completed
        };
        if !self
            .source_progress(
                provider,
                status,
                Some(provider_request_id),
                state.request_count.max(1),
                item_count,
                None,
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        let after = self.source_state(provider).await?.retained_count;
        let retained = after.saturating_sub(before);
        self.retained.fetch_add(retained, Ordering::AcqRel);
        Ok(SourceExecution::Succeeded { retained })
    }

    async fn finish_outscraper_submit_error(
        &self,
        error: OutscraperError,
    ) -> Result<SourceExecution, String> {
        if self.cancellation.is_cancelled() || error == OutscraperError::Cancelled {
            return Ok(SourceExecution::LostLease);
        }
        if matches!(
            error,
            OutscraperError::ProviderUnavailable | OutscraperError::RequestTimedOut
        ) {
            return self
                .finish_source_failure(
                    DiscoveryProvider::Outscraper,
                    None,
                    1,
                    DiscoveryRunSourceFailureClass::OutcomeUnknown,
                )
                .await;
        }
        self.finish_source_failure(
            DiscoveryProvider::Outscraper,
            None,
            1,
            outscraper_failure(error),
        )
        .await
    }

    async fn finish_outscraper_poll_error(
        &self,
        error: OutscraperError,
        state: &DiscoveryRunSourceProjection,
    ) -> Result<SourceExecution, String> {
        if self.cancellation.is_cancelled() || error == OutscraperError::Cancelled {
            return Ok(SourceExecution::LostLease);
        }
        if matches!(
            error,
            OutscraperError::RateLimited
                | OutscraperError::ProviderUnavailable
                | OutscraperError::RequestTimedOut
                | OutscraperError::PollExhausted
        ) {
            return Err("Outscraper polling paused for safe resumption".to_owned());
        }
        self.finish_source_failure(
            DiscoveryProvider::Outscraper,
            state.request_cursor.clone(),
            state.request_count.max(1),
            outscraper_failure(error),
        )
        .await
    }

    async fn finish_source_failure(
        &self,
        provider: DiscoveryProvider,
        cursor: Option<String>,
        request_count: u32,
        failure: DiscoveryRunSourceFailureClass,
    ) -> Result<SourceExecution, String> {
        let status = if failure == DiscoveryRunSourceFailureClass::OutcomeUnknown {
            DiscoveryRunSourceStatus::OutcomeUnknown
        } else {
            DiscoveryRunSourceStatus::Failed
        };
        if !self
            .source_progress(provider, status, cursor, request_count, 0, Some(failure))
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        Ok(SourceExecution::Failed { retained: 0 })
    }

    async fn ensure_submitted(
        &self,
        provider: DiscoveryProvider,
        provider_request_id: &str,
    ) -> Result<bool, String> {
        let state = self.source_state(provider).await?;
        match state.request_cursor.as_deref() {
            Some(existing) if existing == provider_request_id => return Ok(true),
            Some(_) => return Err("Discovery provider cursor conflicts with recovery".to_owned()),
            None => {}
        }
        self.checkpoint(
            DiscoveryCheckpointKind::ProviderSubmitted,
            provider,
            Some(provider_request_id.to_owned()),
            None,
        )
        .await
    }

    async fn checkpoint(
        &self,
        kind: DiscoveryCheckpointKind,
        provider: DiscoveryProvider,
        provider_request_id: Option<String>,
        item_count: Option<u32>,
    ) -> Result<bool, String> {
        let _guard = self.checkpoint_lock.lock().await;
        let lease = self.lease.lock().await.clone();
        let sequence = lease
            .last_checkpoint
            .as_ref()
            .map_or(1, |checkpoint| checkpoint.sequence.saturating_add(1));
        let request = DiscoveryWorkerCheckpointRequest {
            lease: lease_request(&lease),
            checkpoint: DiscoveryWorkerCheckpoint {
                sequence,
                kind,
                provider,
                provider_request_id,
                item_count,
            },
        };
        match self.protocol.checkpoint(request).await? {
            DiscoveryWorkerReceiptOutcome::Lease(updated) => {
                self.merge_lease(updated).await?;
                Ok(true)
            }
            DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                self.cancellation.cancel();
                Ok(false)
            }
            _ => Err("Discovery checkpoint returned an invalid outcome".to_owned()),
        }
    }

    async fn source_progress(
        &self,
        provider: DiscoveryProvider,
        status: DiscoveryRunSourceStatus,
        request_cursor: Option<String>,
        request_count: u32,
        returned_count: u32,
        failure_class: Option<DiscoveryRunSourceFailureClass>,
    ) -> Result<bool, String> {
        let lease = self.lease.lock().await.clone();
        let request = DiscoveryWorkerSourceProgressRequest {
            lease: lease_request(&lease),
            provider,
            status,
            request_cursor,
            request_count,
            returned_count,
            failure_class,
        };
        match self.protocol.source_progress(request).await? {
            DiscoveryWorkerReceiptOutcome::Lease(updated) => {
                self.merge_lease(updated).await?;
                Ok(true)
            }
            DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                self.cancellation.cancel();
                Ok(false)
            }
            _ => Err("Discovery source progress returned an invalid outcome".to_owned()),
        }
    }

    async fn store_observations(
        &self,
        provider: DiscoveryProvider,
        provider_request_id: &str,
        observations: Vec<buzz_core_pkg::discovery_worker::DiscoveryBusinessObservationInput>,
    ) -> Result<bool, String> {
        for (batch_index, observations) in observations.chunks(OBSERVATION_BATCH_SIZE).enumerate() {
            let lease = self.lease.lock().await.clone();
            let request = DiscoveryWorkerObservationBatchRequest {
                lease: lease_request(&lease),
                provider,
                provider_request_id: provider_request_id.to_owned(),
                batch_index: u32::try_from(batch_index)
                    .map_err(|_| "Discovery source returned too many batches".to_owned())?,
                observations: observations.to_vec(),
            };
            match self.protocol.store_observations(request).await? {
                DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) => {
                    self.merge_lease(stored.lease).await?;
                }
                DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                    self.cancellation.cancel();
                    return Ok(false);
                }
                _ => {
                    return Err("Discovery observation write returned an invalid outcome".to_owned())
                }
            }
        }
        Ok(true)
    }

    async fn drain_outbox(&self, call_id: Uuid) -> Result<bool, String> {
        while let Some(batch) = self.outbox.next_batch(call_id)? {
            let lease = self.lease.lock().await.clone();
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
            match self.protocol.store_observations(request).await? {
                DiscoveryWorkerReceiptOutcome::ObservationsStored(stored) => {
                    self.merge_lease(stored.lease).await?;
                    self.outbox.acknowledge_batch(call_id, batch.batch_index)?;
                }
                DiscoveryWorkerReceiptOutcome::LostLease(_) => {
                    self.cancellation.cancel();
                    return Ok(false);
                }
                _ => {
                    return Err("Discovery observation write returned an invalid outcome".to_owned())
                }
            }
        }
        Ok(true)
    }

    async fn heartbeat_loop(&self) -> Result<(), String> {
        loop {
            let interval = {
                let lease = self.lease.lock().await;
                heartbeat_interval(&lease)
            };
            tokio::select! {
                () = self.cancellation.cancelled() => return Ok(()),
                () = tokio::time::sleep(interval) => {}
            }
            if !self.heartbeat_once().await? {
                return Ok(());
            }
        }
    }

    async fn heartbeat_once(&self) -> Result<bool, String> {
        let lease = self.lease.lock().await.clone();
        match self.protocol.heartbeat(lease_request(&lease)).await {
            Ok(DiscoveryWorkerReceiptOutcome::Lease(updated)) => {
                self.merge_lease(updated).await?;
                Ok(true)
            }
            Ok(DiscoveryWorkerReceiptOutcome::LostLease(_)) => {
                self.cancellation.cancel();
                Ok(false)
            }
            Ok(_) => {
                self.cancellation.cancel();
                Err("Discovery heartbeat returned an invalid outcome".to_owned())
            }
            Err(error) => {
                self.cancellation.cancel();
                Err(error)
            }
        }
    }

    async fn source_state(
        &self,
        provider: DiscoveryProvider,
    ) -> Result<DiscoveryRunSourceProjection, String> {
        self.lease
            .lock()
            .await
            .source_states
            .iter()
            .find(|state| state.provider == provider)
            .cloned()
            .ok_or_else(|| "Discovery source is missing from the run plan".to_owned())
    }

    async fn merge_lease(&self, updated: DiscoveryWorkerLeaseProjection) -> Result<(), String> {
        let mut current = self.lease.lock().await;
        if current.worker_id != updated.worker_id
            || current.lease_id != updated.lease_id
            || current.run.run_id != updated.run.run_id
        {
            return Err("Discovery relay returned a different lease".to_owned());
        }
        if updated.lease_until > current.lease_until {
            current.lease_until = updated.lease_until;
        }
        if updated.run.updated_at >= current.run.updated_at {
            current.run = updated.run;
        }
        for source in updated.source_states {
            if let Some(existing) = current
                .source_states
                .iter_mut()
                .find(|existing| existing.provider == source.provider)
            {
                if source.updated_at >= existing.updated_at {
                    *existing = source;
                }
            }
        }
        if updated.last_checkpoint.as_ref().is_some_and(|next| {
            current
                .last_checkpoint
                .as_ref()
                .is_none_or(|existing| next.sequence >= existing.sequence)
        }) {
            current.last_checkpoint = updated.last_checkpoint;
        }
        Ok(())
    }

    async fn remove_terminal_outbox_if_present(
        &self,
        state: &DiscoveryRunSourceProjection,
    ) -> Result<(), String> {
        if matches!(
            state.provider,
            DiscoveryProvider::BraveSearch | DiscoveryProvider::ExaSearch
        ) {
            let run_id = self.lease.lock().await.run.run_id;
            if let Some(call) = self.outbox.call_for(run_id, state.provider) {
                self.outbox.remove_after_relay_ack(call.call_id)?;
            }
        }
        Ok(())
    }

    fn dynamic_remaining(&self, source_remaining: u32) -> u32 {
        let global = self
            .target
            .saturating_sub(self.retained.load(Ordering::Acquire));
        source_remaining.min(global)
    }
}

fn terminal_source_execution(state: &DiscoveryRunSourceProjection) -> Option<SourceExecution> {
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

fn lease_request(lease: &DiscoveryWorkerLeaseProjection) -> DiscoveryWorkerLeaseRequest {
    DiscoveryWorkerLeaseRequest {
        request_id: Uuid::new_v4(),
        idempotency_key: Uuid::new_v4(),
        worker_id: lease.worker_id,
        run_id: lease.run.run_id,
        lease_id: lease.lease_id,
    }
}

fn heartbeat_interval(lease: &DiscoveryWorkerLeaseProjection) -> Duration {
    let remaining = (lease.lease_until - chrono::Utc::now())
        .to_std()
        .unwrap_or(Duration::from_millis(150));
    (remaining / 3).clamp(Duration::from_millis(50), Duration::from_secs(2))
}
