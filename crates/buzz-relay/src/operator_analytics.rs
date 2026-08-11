//! Runtime worker for the deployment-wide operator analytics rollup.
//!
//! The durable cursor and transaction/advisory-lock boundary live in
//! `buzz-db`. This module only schedules bounded calls to that interface. Every
//! relay pod may run the worker; the database serializes overlapping community
//! batches and rejects stale cursor snapshots.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

use crate::state::AppState;

/// Maximum number of source events one transactional rollup call may process.
pub const ROLLUP_BATCH_LIMIT: i64 = 5_000;
/// Interval between rollup sweeps.
pub const ROLLUP_INTERVAL: Duration = Duration::from_secs(30);

/// Per-tick rollup telemetry useful in focused worker tests and logs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RollupTickStats {
    /// Number of active communities enumerated.
    pub communities: usize,
    /// Number of committed transactional batches.
    pub batches: usize,
    /// Number of source events advanced across all batches.
    pub processed: usize,
    /// Number of source events classified into an activity family.
    pub qualifying: usize,
    /// Number of communities whose batch failed and was skipped this tick.
    pub failures: usize,
}

/// Return whether a full batch requires another call for the same community.
#[must_use]
pub const fn batch_is_full(processed: usize) -> bool {
    processed == ROLLUP_BATCH_LIMIT as usize
}

/// Compute source-watermark lag without using the worker wall clock as a
/// watermark. An empty cursor has no source lag and reports zero.
#[must_use]
pub fn source_lag_seconds(last_created_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> i64 {
    last_created_at
        .map(|watermark| now.signed_duration_since(watermark).num_seconds().max(0))
        .unwrap_or(0)
}

/// Run the cancellable 30-second rollup worker until relay shutdown.
pub async fn run(state: Arc<AppState>) {
    let cancel = state.operator_analytics_cancel.clone();
    let mut interval = tokio::time::interval(ROLLUP_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                debug!("operator analytics rollup worker cancelled");
                break;
            }
            _ = interval.tick() => {
                match run_tick(&state).await {
                    Ok(stats) => {
                        debug!(
                            communities = stats.communities,
                            batches = stats.batches,
                            processed = stats.processed,
                            qualifying = stats.qualifying,
                            failures = stats.failures,
                            "operator analytics rollup tick complete"
                        );
                    }
                    Err(error) => {
                        error!(%error, "operator analytics rollup community enumeration failed");
                    }
                }
            }
        }
    }
}

/// Run one bounded sweep over active communities.
pub async fn run_tick(state: &AppState) -> Result<RollupTickStats, buzz_db::DbError> {
    let communities = state.db.list_active_communities().await?;
    let mut stats = RollupTickStats {
        communities: communities.len(),
        ..RollupTickStats::default()
    };
    let mut max_lag_seconds = 0i64;

    for community in communities {
        let mut cursor = match state.db.operator_activity_cursor(community.id).await {
            Ok(cursor) => cursor,
            Err(error) => {
                stats.failures += 1;
                warn!(
                    community_id = %community.id,
                    %error,
                    "operator analytics cursor read failed"
                );
                continue;
            }
        };

        loop {
            let result = match state
                .db
                .operator_rollup_batch(community.id, &cursor, ROLLUP_BATCH_LIMIT)
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    stats.failures += 1;
                    warn!(
                        community_id = %community.id,
                        %error,
                        "operator analytics rollup batch failed"
                    );
                    break;
                }
            };

            let processed = result.processed;
            let qualifying = result.qualifying;
            let next_cursor = result.cursor;
            stats.batches += 1;
            stats.processed += processed;
            stats.qualifying += qualifying;
            metrics::counter!("buzz_operator_rollup_batches_total").increment(1);
            cursor = next_cursor;
            max_lag_seconds =
                max_lag_seconds.max(source_lag_seconds(cursor.last_created_at, Utc::now()));

            if !batch_is_full(processed) {
                break;
            }
        }
    }

    metrics::gauge!("buzz_operator_rollup_lag_seconds").set(max_lag_seconds as f64);

    match state
        .operator_sessions
        .counts(buzz_pubsub::operator_sessions::OperatorSessionScope::all())
        .await
    {
        Ok(counts) => {
            metrics::gauge!("buzz_operator_sessions_active")
                .set(counts.authenticated_sessions as f64);
        }
        Err(error) => {
            metrics::counter!("buzz_operator_session_count_errors_total").increment(1);
            warn!(%error, "operator analytics session count failed");
        }
    }

    Ok(stats)
}

/// A small helper used by cancellation tests to make the worker's shutdown
/// contract explicit without constructing the full relay state.
pub async fn wait_for_cancel(cancel: CancellationToken) {
    cancel.cancelled().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_batches_repeat() {
        assert!(!batch_is_full(0));
        assert!(!batch_is_full(ROLLUP_BATCH_LIMIT as usize - 1));
        assert!(batch_is_full(ROLLUP_BATCH_LIMIT as usize));
        assert!(!batch_is_full(ROLLUP_BATCH_LIMIT as usize + 1));
    }

    #[test]
    fn source_lag_uses_cursor_watermark_and_clamps_future() {
        let now = Utc::now();
        assert_eq!(source_lag_seconds(None, now), 0);
        assert_eq!(
            source_lag_seconds(Some(now - chrono::Duration::seconds(7)), now),
            7
        );
        assert_eq!(
            source_lag_seconds(Some(now + chrono::Duration::seconds(7)), now),
            0
        );
    }

    #[tokio::test]
    async fn cancellation_wait_returns_after_signal() {
        let cancel = CancellationToken::new();
        let waiter = wait_for_cancel(cancel.clone());
        cancel.cancel();
        waiter.await;
    }
}
