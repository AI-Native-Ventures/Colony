use super::*;

enum HostedSubmitResult {
    Response(super::super::hosted_gateway::HostedProviderResponse),
    Failed(DiscoveryRunSourceFailureClass),
}

impl<P: WorkerProtocol> ProductionSourceExecutor<'_, P> {
    async fn submit_hosted_with_recovery(
        &self,
        run_id: Uuid,
        lease_id: Uuid,
        provider: DiscoveryProvider,
    ) -> HostedSubmitResult {
        let mut final_failure = DiscoveryRunSourceFailureClass::RateLimited;
        for attempt in 0..4 {
            match self
                .protocol
                .hosted_provider_submit(run_id, lease_id, provider)
                .await
            {
                Ok(response) => return HostedSubmitResult::Response(response),
                Err(error) if error.contains("no longer authorized") => {
                    return HostedSubmitResult::Failed(
                        if final_failure == DiscoveryRunSourceFailureClass::OutcomeUnknown {
                            final_failure
                        } else {
                            DiscoveryRunSourceFailureClass::CredentialRejected
                        },
                    );
                }
                Err(error) if error.contains("rate limited") => {}
                Err(_) => {
                    final_failure = DiscoveryRunSourceFailureClass::OutcomeUnknown;
                }
            }
            if attempt < 3 {
                tokio::time::sleep(std::time::Duration::from_secs(11)).await;
            }
        }
        HostedSubmitResult::Failed(final_failure)
    }

    pub(super) async fn execute_hosted_source(
        &self,
        provider: DiscoveryProvider,
        remaining_target: u32,
    ) -> Result<SourceExecution, String> {
        let state = self.source_state(provider).await?;
        let lease = self.lease.lock().await.clone();
        let run_id = lease.run.run_id;
        let lease_id = lease.lease_id;
        let existing_call = self.outbox.call_for(run_id, provider);
        if let Some(call) = existing_call.filter(|_| {
            self.outbox.state_for(run_id, provider) == Some(SynchronousCallState::Ready)
        }) {
            return self
                .finish_synchronous(call.call_id, provider, state.retained_count)
                .await;
        }
        if self.dynamic_remaining(remaining_target) == 0 {
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
            return Ok(SourceExecution::Succeeded { retained: 0 });
        }

        let before = state.retained_count;
        let (call_id, mut provider_request_id, ready) = match existing_call {
            Some(call)
                if self.outbox.state_for(run_id, provider)
                    == Some(SynchronousCallState::Submitted) =>
            {
                let request_id = self
                    .outbox
                    .submitted_request_id(call.call_id)?
                    .ok_or_else(|| "Hosted Discovery submission disappeared".to_owned())?;
                (call.call_id, request_id, None)
            }
            Some(call)
                if matches!(
                    self.outbox.state_for(run_id, provider),
                    Some(SynchronousCallState::Intent | SynchronousCallState::OutcomeUnknown)
                ) =>
            {
                let response = match self
                    .submit_hosted_with_recovery(run_id, lease_id, provider)
                    .await
                {
                    HostedSubmitResult::Response(response) => response,
                    HostedSubmitResult::Failed(failure) => {
                        if failure == DiscoveryRunSourceFailureClass::OutcomeUnknown {
                            self.outbox.mark_outcome_unknown(call.call_id)?;
                        }
                        return self
                            .finish_source_failure(provider, None, 1, failure)
                            .await;
                    }
                };
                let (request_id, observations) = match response {
                    super::super::hosted_gateway::HostedProviderResponse::Pending {
                        provider_request_id,
                    } => (provider_request_id, None),
                    super::super::hosted_gateway::HostedProviderResponse::Ready {
                        provider_request_id,
                        observations,
                    } => (provider_request_id, Some(observations)),
                };
                self.outbox.mark_submitted(call.call_id, &request_id)?;
                if !self.ensure_submitted(provider, &request_id).await? {
                    return Ok(SourceExecution::LostLease);
                }
                (call.call_id, request_id, observations)
            }
            Some(_) => return Err("invalid hosted Discovery outbox state".to_owned()),
            None => {
                let intent = self.outbox.begin_call(run_id, provider)?;
                let response = match self
                    .submit_hosted_with_recovery(run_id, lease_id, provider)
                    .await
                {
                    HostedSubmitResult::Response(response) => response,
                    HostedSubmitResult::Failed(failure) => {
                        if failure == DiscoveryRunSourceFailureClass::OutcomeUnknown {
                            self.outbox.mark_outcome_unknown(intent.call_id)?;
                        }
                        return self
                            .finish_source_failure(provider, None, 1, failure)
                            .await;
                    }
                };
                let (request_id, observations) = match response {
                    super::super::hosted_gateway::HostedProviderResponse::Pending {
                        provider_request_id,
                    } => (provider_request_id, None),
                    super::super::hosted_gateway::HostedProviderResponse::Ready {
                        provider_request_id,
                        observations,
                    } => (provider_request_id, Some(observations)),
                };
                self.outbox.mark_submitted(intent.call_id, &request_id)?;
                if !self.ensure_submitted(provider, &request_id).await? {
                    return Ok(SourceExecution::LostLease);
                }
                (intent.call_id, request_id, observations)
            }
        };

        if !self
            .ensure_submitted(provider, &provider_request_id)
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        let observations = if let Some(observations) = ready {
            observations
        } else {
            let mut resolved = None;
            for _ in 0..150 {
                if !self.heartbeat_once().await? {
                    return Ok(SourceExecution::LostLease);
                }
                match self
                    .protocol
                    .hosted_provider_poll(run_id, lease_id, provider, &provider_request_id)
                    .await?
                {
                    super::super::hosted_gateway::HostedProviderResponse::Pending {
                        provider_request_id: returned,
                    } if returned == provider_request_id => {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    super::super::hosted_gateway::HostedProviderResponse::Ready {
                        provider_request_id: returned,
                        observations,
                    } if returned == provider_request_id => {
                        resolved = Some(observations);
                        break;
                    }
                    _ => return Err("Hosted Discovery request identity changed".to_owned()),
                }
            }
            resolved.ok_or_else(|| "Hosted Discovery provider did not finish in time".to_owned())?
        };
        if observations.len() > 500 {
            return self
                .finish_source_failure(
                    provider,
                    Some(provider_request_id),
                    1,
                    DiscoveryRunSourceFailureClass::ResponseTooLarge,
                )
                .await;
        }
        // Hosted protocol results are already durable and capacity-bounded in
        // the relay transaction before they are returned to this device.
        let item_count = u32::try_from(observations.len())
            .map_err(|_| "Hosted Discovery returned too many businesses".to_owned())?;
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
                Some(std::mem::take(&mut provider_request_id)),
                1,
                item_count,
                None,
            )
            .await?
        {
            return Ok(SourceExecution::LostLease);
        }
        self.outbox.remove_after_relay_ack(call_id)?;
        let after = self.source_state(provider).await?.retained_count;
        Ok(SourceExecution::Succeeded {
            retained: after.saturating_sub(before),
        })
    }

    pub(super) async fn execute_outscraper(
        &self,
        remaining_target: u32,
    ) -> Result<SourceExecution, String> {
        let provider = DiscoveryProvider::Outscraper;
        let mut state = self.source_state(provider).await?;
        let run_id = self.lease.lock().await.run.run_id;
        let existing_call = self.outbox.call_for(run_id, provider);
        if let Some(call) = existing_call.filter(|_| {
            self.outbox.state_for(run_id, provider) == Some(SynchronousCallState::Ready)
        }) {
            return self
                .finish_synchronous(call.call_id, provider, state.retained_count)
                .await;
        }
        let credential = self
            .credentials
            .credential(provider)
            .ok_or_else(|| "configured Outscraper credential disappeared".to_owned())?;
        let search = self.lease.lock().await.business_search.clone();
        let mut call_id = existing_call.map(|call| call.call_id);
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
        } else if let Some(call) = existing_call {
            match self.outbox.state_for(run_id, provider) {
                Some(SynchronousCallState::Submitted) => {
                    let provider_request_id = self
                        .outbox
                        .submitted_request_id(call.call_id)?
                        .ok_or_else(|| "Outscraper submission disappeared".to_owned())?;
                    if !self
                        .ensure_submitted(provider, &provider_request_id)
                        .await?
                    {
                        return Ok(SourceExecution::LostLease);
                    }
                    state = self.source_state(provider).await?;
                    (provider_request_id, None)
                }
                Some(SynchronousCallState::Intent) => {
                    self.outbox.mark_outcome_unknown(call.call_id)?;
                    return self
                        .finish_source_failure(
                            provider,
                            None,
                            1,
                            DiscoveryRunSourceFailureClass::OutcomeUnknown,
                        )
                        .await;
                }
                Some(SynchronousCallState::OutcomeUnknown) => {
                    return self
                        .finish_source_failure(
                            provider,
                            None,
                            1,
                            DiscoveryRunSourceFailureClass::OutcomeUnknown,
                        )
                        .await;
                }
                Some(SynchronousCallState::Ready) | None => {
                    return Err("invalid Outscraper outbox state".to_owned())
                }
            }
        } else {
            let remaining = self.dynamic_remaining(remaining_target);
            if remaining == 0 {
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
                return Ok(SourceExecution::Succeeded { retained: 0 });
            }
            let mut submitted_search = search.clone();
            submitted_search.limit = u16::try_from(remaining)
                .map_err(|_| "Outscraper remaining target exceeds u16".to_owned())?;
            let intent = self.outbox.begin_call(run_id, provider)?;
            call_id = Some(intent.call_id);
            let submission = match self
                .clients
                .outscraper
                .submit_with_preflight(
                    &submitted_search,
                    credential,
                    || async { self.heartbeat_once().await.unwrap_or(false) },
                    &self.cancellation,
                )
                .await
            {
                Ok(submission) => submission,
                Err(error) => {
                    return self
                        .finish_outscraper_submit_error(intent.call_id, error)
                        .await
                }
            };
            self.outbox
                .mark_submitted(intent.call_id, &submission.request_id)?;
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
                .poll_until_ready_with_preflight(
                    &provider_request_id,
                    credential,
                    || async { self.heartbeat_once().await.unwrap_or(false) },
                    &self.cancellation,
                )
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
        if let Some(call_id) = call_id {
            self.outbox.record_results(
                call_id,
                Some(provider_request_id.clone()),
                u16::try_from(state.request_count.max(1))
                    .map_err(|_| "Outscraper request count exceeds u16".to_owned())?,
                observations.clone(),
            )?;
            if !self.drain_outbox(call_id).await? {
                return Ok(SourceExecution::LostLease);
            }
        } else if !self
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
        if let Some(call_id) = call_id {
            self.outbox.remove_after_relay_ack(call_id)?;
        }
        let after = self.source_state(provider).await?.retained_count;
        let retained = after.saturating_sub(before);
        Ok(SourceExecution::Succeeded { retained })
    }

    async fn finish_outscraper_submit_error(
        &self,
        call_id: Uuid,
        failure: OutscraperSubmitFailure,
    ) -> Result<SourceExecution, String> {
        let error = failure.error;
        if failure.ambiguous {
            self.outbox.mark_outcome_unknown(call_id)?;
        } else {
            self.outbox.discard_unsubmitted(call_id)?;
        }
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
}
