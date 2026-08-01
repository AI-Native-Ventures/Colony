//! Restart-safe worker loop for the zero-cost Discovery foundation executor.

use std::{sync::Arc, time::Duration as StdDuration};

use buzz_db::discovery::{ClaimedDiscoveryRun, DiscoveryAdvance};
use chrono::Duration;
use tracing::{error, info, warn};

use crate::state::AppState;

/// Spawn the configured, bounded set of fake Discovery workers.
///
/// This function is a no-op unless the fake executor is explicitly enabled.
pub fn spawn_workers(state: Arc<AppState>) {
    if !state.config.discovery.fake_executor_enabled {
        return;
    }
    for worker_index in 0..state.config.discovery.worker_count {
        let worker_state = Arc::clone(&state);
        tokio::spawn(async move { run_worker(worker_state, worker_index).await });
    }
    info!(
        workers = state.config.discovery.worker_count,
        steps = state.config.discovery.fake_total_steps,
        "deterministic Discovery fake executor started"
    );
}

async fn run_worker(state: Arc<AppState>, worker_index: usize) {
    let lease = Duration::seconds(state.config.discovery.lease_seconds as i64);
    let idle = StdDuration::from_millis(state.config.discovery.poll_millis);
    loop {
        match state.db.claim_discovery_run(lease).await {
            Ok(Some(claimed)) => process_claim(&state, worker_index, claimed).await,
            Ok(None) => tokio::time::sleep(idle).await,
            Err(error) => {
                error!(worker_index, %error, "Discovery worker claim failed");
                tokio::time::sleep(idle).await;
            }
        }
    }
}

async fn process_claim(state: &AppState, worker_index: usize, claimed: ClaimedDiscoveryRun) {
    let run_id = claimed.run.id;
    let community_id = claimed.run.community_id;
    let claim_id = claimed.claim_id;
    let mut cancel_requested = claimed.run.cancel_requested;
    info!(
        worker_index,
        %community_id,
        %run_id,
        %claim_id,
        attempt = claimed.run.attempt,
        "Discovery worker claimed run"
    );

    loop {
        // A cancellation already present at claim time should not wait for a
        // fake step. Entitlement is rechecked by the same fenced transaction.
        if !cancel_requested {
            execute_fake_step(state.config.discovery.fake_step_millis).await;
        }
        match state
            .db
            .advance_discovery_step(community_id, run_id, claim_id)
            .await
        {
            Ok(DiscoveryAdvance::Advanced(run)) => {
                cancel_requested = run.cancel_requested;
                info!(
                    worker_index,
                    %run_id,
                    completed_steps = run.completed_steps,
                    total_steps = run.total_steps,
                    "Discovery fake step committed"
                );
            }
            Ok(DiscoveryAdvance::Completed(run)) => {
                info!(
                    worker_index,
                    %run_id,
                    completed_steps = run.completed_steps,
                    "Discovery fake run completed"
                );
                return;
            }
            Ok(DiscoveryAdvance::Cancelled(run)) => {
                info!(
                    worker_index,
                    %run_id,
                    reason = ?run.terminal_reason,
                    "Discovery run stopped at fenced boundary"
                );
                return;
            }
            Ok(DiscoveryAdvance::LostLease) => {
                warn!(worker_index, %run_id, %claim_id, "Discovery worker lost lease");
                return;
            }
            Err(error) => {
                error!(worker_index, %run_id, %claim_id, %error, "Discovery step failed");
                if let Err(fail_error) = state
                    .db
                    .fail_discovery_run(community_id, run_id, claim_id)
                    .await
                {
                    error!(worker_index, %run_id, %fail_error, "Discovery failure could not be recorded");
                }
                return;
            }
        }
    }
}

/// Fixed no-network executor seam. A real provider adapter replaces only this
/// step in a later phase; command, authorization, and fencing remain unchanged.
async fn execute_fake_step(delay_millis: u64) {
    tokio::time::sleep(StdDuration::from_millis(delay_millis)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_step_is_deterministic_and_zero_cost() {
        tokio::time::pause();
        let step = tokio::spawn(execute_fake_step(25));
        tokio::time::advance(StdDuration::from_millis(24)).await;
        assert!(!step.is_finished());
        tokio::time::advance(StdDuration::from_millis(1)).await;
        step.await.expect("fake step task must finish");
    }
}
