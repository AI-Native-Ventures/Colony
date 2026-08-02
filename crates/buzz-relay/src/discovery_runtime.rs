//! Restart-safe worker loop for the zero-cost Discovery foundation executor.

use std::{sync::Arc, time::Duration as StdDuration};

use buzz_db::{
    discovery::{ClaimedDiscoveryRun, DiscoveryAdvance, DiscoveryRunRecord},
    Db,
};
use chrono::Duration;
use thiserror::Error;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::{config::DiscoveryConfig, state::AppState};

/// Failure returned by a Discovery executor step.
#[derive(Debug, Error)]
pub enum DiscoveryExecutorError {
    /// The executor could not complete the requested step.
    #[error("executor step failed: {0}")]
    Failed(String),
}

/// Narrow boundary implemented by fake and, later, real provider executors.
#[async_trait::async_trait]
pub trait DiscoveryExecutor: Send + Sync {
    /// Execute one numbered step without committing durable progress.
    async fn execute_step(
        &self,
        run: &DiscoveryRunRecord,
        step_number: u32,
    ) -> Result<(), DiscoveryExecutorError>;
}

/// Fixed no-network, no-filesystem, no-LLM executor used only for foundation proof.
pub struct DeterministicFakeDiscoveryExecutor {
    delay: StdDuration,
}

impl DeterministicFakeDiscoveryExecutor {
    fn new(delay_millis: u64) -> Self {
        Self {
            delay: StdDuration::from_millis(delay_millis),
        }
    }
}

#[async_trait::async_trait]
impl DiscoveryExecutor for DeterministicFakeDiscoveryExecutor {
    async fn execute_step(
        &self,
        _run: &DiscoveryRunRecord,
        _step_number: u32,
    ) -> Result<(), DiscoveryExecutorError> {
        tokio::time::sleep(self.delay).await;
        Ok(())
    }
}

/// Spawn the configured, bounded set of fake Discovery workers.
///
/// This function is a no-op unless the fake executor is explicitly enabled.
pub fn spawn_workers(state: Arc<AppState>, shutdown: CancellationToken) {
    if !state.config.discovery.fake_executor_enabled {
        return;
    }
    let executor: Arc<dyn DiscoveryExecutor> = Arc::new(DeterministicFakeDiscoveryExecutor::new(
        state.config.discovery.fake_step_millis,
    ));
    for worker_index in 0..state.config.discovery.worker_count {
        let worker_state = Arc::clone(&state);
        let worker_executor = Arc::clone(&executor);
        let worker_shutdown = shutdown.child_token();
        tokio::spawn(async move {
            run_worker(
                worker_state.db.clone(),
                worker_executor,
                worker_state.config.discovery.clone(),
                worker_shutdown,
                worker_index,
            )
            .await
        });
    }
    info!(
        workers = state.config.discovery.worker_count,
        steps = state.config.discovery.fake_total_steps,
        "deterministic Discovery fake executor started"
    );
}

async fn run_worker(
    db: Db,
    executor: Arc<dyn DiscoveryExecutor>,
    config: DiscoveryConfig,
    shutdown: CancellationToken,
    worker_index: usize,
) {
    let lease = Duration::seconds(config.lease_seconds as i64);
    let idle = StdDuration::from_millis(config.poll_millis);
    loop {
        if shutdown.is_cancelled() {
            info!(worker_index, "Discovery worker stopped");
            return;
        }
        match db.claim_discovery_run(lease).await {
            Ok(Some(claimed)) => {
                process_claim(
                    &db,
                    executor.as_ref(),
                    &config,
                    &shutdown,
                    worker_index,
                    claimed,
                )
                .await
            }
            Ok(None) => {
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(idle) => {}
                }
            }
            Err(error) => {
                error!(worker_index, %error, "Discovery worker claim failed");
                tokio::select! {
                    () = shutdown.cancelled() => return,
                    () = tokio::time::sleep(idle) => {}
                }
            }
        }
    }
}

async fn process_claim(
    db: &Db,
    executor: &dyn DiscoveryExecutor,
    config: &DiscoveryConfig,
    shutdown: &CancellationToken,
    worker_index: usize,
    claimed: ClaimedDiscoveryRun,
) {
    let run_id = claimed.run.id;
    let community_id = claimed.run.community_id;
    let claim_id = claimed.claim_id;
    let mut run = claimed.run;
    info!(
        worker_index,
        %community_id,
        %run_id,
        %claim_id,
        attempt = run.attempt,
        "Discovery worker claimed run"
    );

    loop {
        let next_step = run.completed_steps + 1;
        if !run.cancel_requested {
            match execute_with_lease_renewal(
                db, executor, config, shutdown, &run, next_step, claim_id,
            )
            .await
            {
                StepExecution::Completed => {}
                StepExecution::Shutdown | StepExecution::LostLease => return,
                StepExecution::Failed(error) => {
                    error!(worker_index, %run_id, %claim_id, %error, "Discovery step failed");
                    if let Err(fail_error) =
                        db.fail_discovery_run(community_id, run_id, claim_id).await
                    {
                        error!(worker_index, %run_id, %fail_error, "Discovery failure could not be recorded");
                    }
                    return;
                }
            }
        }

        match db
            .advance_discovery_step(community_id, run_id, claim_id)
            .await
        {
            Ok(DiscoveryAdvance::Advanced(advanced)) => {
                run = advanced;
                info!(
                    worker_index,
                    %run_id,
                    completed_steps = run.completed_steps,
                    total_steps = run.total_steps,
                    "Discovery fake step committed"
                );
            }
            Ok(DiscoveryAdvance::Completed(completed)) => {
                info!(
                    worker_index,
                    %run_id,
                    completed_steps = completed.completed_steps,
                    "Discovery fake run completed"
                );
                return;
            }
            Ok(DiscoveryAdvance::Cancelled(cancelled)) => {
                info!(
                    worker_index,
                    %run_id,
                    reason = ?cancelled.terminal_reason,
                    "Discovery run stopped at fenced boundary"
                );
                return;
            }
            Ok(DiscoveryAdvance::LostLease) => {
                warn!(worker_index, %run_id, %claim_id, "Discovery worker lost lease");
                return;
            }
            Err(error) => {
                error!(worker_index, %run_id, %claim_id, %error, "Discovery progress commit failed");
                return;
            }
        }
    }
}

enum StepExecution {
    Completed,
    Shutdown,
    LostLease,
    Failed(DiscoveryExecutorError),
}

async fn execute_with_lease_renewal(
    db: &Db,
    executor: &dyn DiscoveryExecutor,
    config: &DiscoveryConfig,
    shutdown: &CancellationToken,
    run: &DiscoveryRunRecord,
    step_number: u32,
    claim_id: uuid::Uuid,
) -> StepExecution {
    let execute = executor.execute_step(run, step_number);
    tokio::pin!(execute);
    let renew_every = StdDuration::from_secs((config.lease_seconds / 2).max(1));
    let mut renew = tokio::time::interval(renew_every);
    renew.tick().await;
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return StepExecution::Shutdown,
            result = &mut execute => return match result {
                Ok(()) => StepExecution::Completed,
                Err(error) => StepExecution::Failed(error),
            },
            _ = renew.tick() => {
                let lease = Duration::seconds(config.lease_seconds as i64);
                match db.renew_discovery_lease(run.community_id, run.id, claim_id, lease).await {
                    Ok(true) => {}
                    Ok(false) => return StepExecution::LostLease,
                    Err(error) => {
                        warn!(run_id = %run.id, %claim_id, %error, "Discovery lease renewal failed");
                        return StepExecution::LostLease;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_executor_is_deterministic_and_zero_cost() {
        tokio::time::pause();
        let executor = DeterministicFakeDiscoveryExecutor::new(25);
        let run = test_run();
        let step = tokio::spawn(async move { executor.execute_step(&run, 1).await });
        tokio::time::advance(StdDuration::from_millis(24)).await;
        assert!(!step.is_finished());
        tokio::time::advance(StdDuration::from_millis(1)).await;
        step.await
            .expect("fake step task must finish")
            .expect("fake step must succeed");
    }

    fn test_run() -> DiscoveryRunRecord {
        let now = chrono::Utc::now();
        DiscoveryRunRecord {
            id: uuid::Uuid::new_v4(),
            community_id: buzz_core::CommunityId::from_uuid(uuid::Uuid::new_v4()),
            campaign_id: uuid::Uuid::new_v4(),
            requested_by: [1; 32],
            start_idempotency_key: uuid::Uuid::new_v4(),
            state: buzz_core::discovery::DiscoveryRunState::Running,
            completed_steps: 0,
            total_steps: 5,
            cancel_requested: false,
            claim_id: None,
            lease_until: None,
            worker_id: None,
            lease_owner_pubkey: None,
            last_checkpoint_sequence: 0,
            attempt: 1,
            terminal_reason: None,
            created_at: now,
            updated_at: now,
        }
    }
}
