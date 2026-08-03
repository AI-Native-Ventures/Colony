use std::{future::Future, pin::Pin};

use buzz_core_pkg::discovery::{DiscoverySource, DiscoverySourceConfig, DiscoverySourceMode};
use futures_util::future::join_all;

pub(super) type SourceFuture<'a> =
    Pin<Box<dyn Future<Output = Result<SourceExecution, String>> + Send + 'a>>;

pub(super) trait SourceExecutor: Send + Sync {
    fn execute(&self, source: DiscoverySource, remaining_target: u32) -> SourceFuture<'_>;
    fn skip_target_met(&self, source: DiscoverySource) -> SourceFuture<'_>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SourceExecution {
    Succeeded { retained: u32 },
    Failed { retained: u32 },
    LostLease,
    Cancelled,
}

impl SourceExecution {
    const fn retained(self) -> u32 {
        match self {
            Self::Succeeded { retained } | Self::Failed { retained } => retained,
            Self::LostLease | Self::Cancelled => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PlanExecution {
    Completed { retained: u32 },
    Failed,
    LostLease,
    Cancelled,
}

pub(super) async fn execute_source_plan<E: SourceExecutor>(
    executor: &E,
    config: &DiscoverySourceConfig,
    target: u32,
    initial_retained: u32,
) -> Result<PlanExecution, String> {
    config
        .validate()
        .map_err(|_| "invalid Discovery source plan".to_owned())?;
    match config.mode {
        DiscoverySourceMode::Waterfall => {
            execute_waterfall(executor, &config.sources, target, initial_retained).await
        }
        DiscoverySourceMode::Concurrent => {
            execute_concurrent(executor, &config.sources, target, initial_retained).await
        }
    }
}

async fn execute_waterfall<E: SourceExecutor>(
    executor: &E,
    sources: &[DiscoverySource],
    target: u32,
    initial_retained: u32,
) -> Result<PlanExecution, String> {
    let mut retained = initial_retained;
    let mut failed = 0usize;
    for source in sources {
        let outcome = if retained >= target {
            executor.skip_target_met(*source).await?
        } else {
            executor
                .execute(*source, target.saturating_sub(retained))
                .await?
        };
        match outcome {
            SourceExecution::Succeeded {
                retained: source_retained,
            } => retained = retained.saturating_add(source_retained),
            SourceExecution::Failed {
                retained: source_retained,
            } => {
                retained = retained.saturating_add(source_retained);
                failed += 1;
            }
            SourceExecution::LostLease => return Ok(PlanExecution::LostLease),
            SourceExecution::Cancelled => return Ok(PlanExecution::Cancelled),
        }
    }
    if failed == sources.len() && retained == 0 {
        Ok(PlanExecution::Failed)
    } else {
        Ok(PlanExecution::Completed { retained })
    }
}

async fn execute_concurrent<E: SourceExecutor>(
    executor: &E,
    sources: &[DiscoverySource],
    target: u32,
    initial_retained: u32,
) -> Result<PlanExecution, String> {
    let remaining = target.saturating_sub(initial_retained);
    let futures = sources.iter().copied().map(|source| {
        if remaining == 0 {
            executor.skip_target_met(source)
        } else {
            executor.execute(source, remaining)
        }
    });
    let outcomes = join_all(futures).await;
    let mut retained = initial_retained;
    let mut failed = 0usize;
    for outcome in outcomes {
        let outcome = outcome?;
        retained = retained.saturating_add(outcome.retained());
        match outcome {
            SourceExecution::Failed { .. } => failed += 1,
            SourceExecution::LostLease => return Ok(PlanExecution::LostLease),
            SourceExecution::Cancelled => return Ok(PlanExecution::Cancelled),
            SourceExecution::Succeeded { .. } => {}
        }
    }
    if failed == sources.len() && retained == 0 {
        Ok(PlanExecution::Failed)
    } else {
        Ok(PlanExecution::Completed { retained })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    use tokio::sync::Notify;

    use super::*;

    struct RecordingExecutor {
        events: Mutex<Vec<String>>,
        outcomes: Vec<(DiscoverySource, SourceExecution)>,
        barrier: Option<Barrier>,
    }

    struct Barrier {
        expected: usize,
        started: AtomicUsize,
        all_started: Notify,
        release: Notify,
    }

    impl RecordingExecutor {
        fn sequential(
            outcomes: impl IntoIterator<Item = (DiscoverySource, SourceExecution)>,
        ) -> Self {
            Self {
                events: Mutex::new(Vec::new()),
                outcomes: outcomes.into_iter().collect(),
                barrier: None,
            }
        }

        fn concurrent(
            expected: usize,
            outcomes: impl IntoIterator<Item = (DiscoverySource, SourceExecution)>,
        ) -> Self {
            Self {
                events: Mutex::new(Vec::new()),
                outcomes: outcomes.into_iter().collect(),
                barrier: Some(Barrier {
                    expected,
                    started: AtomicUsize::new(0),
                    all_started: Notify::new(),
                    release: Notify::new(),
                }),
            }
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().expect("events").clone()
        }
    }

    impl SourceExecutor for RecordingExecutor {
        fn execute(&self, source: DiscoverySource, _: u32) -> SourceFuture<'_> {
            Box::pin(async move {
                self.events
                    .lock()
                    .expect("events")
                    .push(format!("start:{source:?}"));
                if let Some(barrier) = &self.barrier {
                    let released = barrier.release.notified();
                    if barrier.started.fetch_add(1, Ordering::SeqCst) + 1 == barrier.expected {
                        barrier.all_started.notify_one();
                    }
                    released.await;
                }
                self.events
                    .lock()
                    .expect("events")
                    .push(format!("end:{source:?}"));
                self.outcomes
                    .iter()
                    .find_map(|(candidate, outcome)| (*candidate == source).then_some(*outcome))
                    .ok_or_else(|| "missing source outcome".to_owned())
            })
        }

        fn skip_target_met(&self, source: DiscoverySource) -> SourceFuture<'_> {
            Box::pin(async move {
                self.events
                    .lock()
                    .expect("events")
                    .push(format!("skip:{source:?}"));
                Ok(SourceExecution::Succeeded { retained: 0 })
            })
        }
    }

    fn three_sources(mode: DiscoverySourceMode) -> DiscoverySourceConfig {
        DiscoverySourceConfig {
            mode,
            sources: vec![
                DiscoverySource::GoogleMaps,
                DiscoverySource::BraveSearch,
                DiscoverySource::ExaSearch,
            ],
        }
    }

    #[tokio::test]
    async fn waterfall_executes_saved_order_and_skips_after_net_new_target() {
        let executor = RecordingExecutor::sequential([
            (
                DiscoverySource::GoogleMaps,
                SourceExecution::Succeeded { retained: 3 },
            ),
            (
                DiscoverySource::BraveSearch,
                SourceExecution::Succeeded { retained: 99 },
            ),
            (
                DiscoverySource::ExaSearch,
                SourceExecution::Succeeded { retained: 99 },
            ),
        ]);
        let outcome = execute_source_plan(
            &executor,
            &three_sources(DiscoverySourceMode::Waterfall),
            3,
            0,
        )
        .await
        .expect("waterfall plan");
        assert_eq!(outcome, PlanExecution::Completed { retained: 3 });
        assert_eq!(
            executor.events(),
            [
                "start:GoogleMaps",
                "end:GoogleMaps",
                "skip:BraveSearch",
                "skip:ExaSearch"
            ]
        );
    }

    #[tokio::test]
    async fn concurrent_starts_every_source_before_any_response_is_released() {
        let executor = Arc::new(RecordingExecutor::concurrent(
            3,
            [
                (
                    DiscoverySource::GoogleMaps,
                    SourceExecution::Succeeded { retained: 2 },
                ),
                (
                    DiscoverySource::BraveSearch,
                    SourceExecution::Succeeded { retained: 2 },
                ),
                (
                    DiscoverySource::ExaSearch,
                    SourceExecution::Succeeded { retained: 2 },
                ),
            ],
        ));
        let task_executor = Arc::clone(&executor);
        let task = tokio::spawn(async move {
            execute_source_plan(
                task_executor.as_ref(),
                &three_sources(DiscoverySourceMode::Concurrent),
                3,
                0,
            )
            .await
        });
        executor
            .barrier
            .as_ref()
            .expect("barrier")
            .all_started
            .notified()
            .await;
        let before_release = executor.events();
        assert_eq!(before_release.len(), 3);
        assert!(before_release
            .iter()
            .all(|event| event.starts_with("start:")));
        executor
            .barrier
            .as_ref()
            .expect("barrier")
            .release
            .notify_waiters();
        assert_eq!(
            task.await
                .expect("coordinator task")
                .expect("concurrent plan"),
            PlanExecution::Completed { retained: 6 }
        );
        assert_eq!(
            executor
                .events()
                .iter()
                .filter(|event| event.starts_with("end:"))
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn one_source_failure_preserves_success_but_all_failures_fail_the_run() {
        let config = DiscoverySourceConfig {
            mode: DiscoverySourceMode::Concurrent,
            sources: vec![DiscoverySource::BraveSearch, DiscoverySource::ExaSearch],
        };
        let partial = RecordingExecutor::sequential([
            (
                DiscoverySource::BraveSearch,
                SourceExecution::Failed { retained: 0 },
            ),
            (
                DiscoverySource::ExaSearch,
                SourceExecution::Succeeded { retained: 1 },
            ),
        ]);
        assert_eq!(
            execute_source_plan(&partial, &config, 5, 0)
                .await
                .expect("partial plan"),
            PlanExecution::Completed { retained: 1 }
        );

        let failed = RecordingExecutor::sequential([
            (
                DiscoverySource::BraveSearch,
                SourceExecution::Failed { retained: 0 },
            ),
            (
                DiscoverySource::ExaSearch,
                SourceExecution::Failed { retained: 0 },
            ),
        ]);
        assert_eq!(
            execute_source_plan(&failed, &config, 5, 0)
                .await
                .expect("failed plan"),
            PlanExecution::Failed
        );
    }
}
