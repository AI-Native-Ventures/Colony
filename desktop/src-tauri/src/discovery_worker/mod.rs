//! Device-local Discovery worker host.

mod adapter;
#[expect(
    dead_code,
    reason = "the tested synchronous adapters are wired into the coordinator in Task 9"
)]
mod brave;
#[expect(
    dead_code,
    reason = "the tested synchronous adapters are wired into the coordinator in Task 9"
)]
mod exa;
mod installation;
mod normalization;
mod outscraper;
mod protocol;
mod worker_host;

use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) use worker_host::{start_fake_local_worker, start_production_local_worker};

static WORKSPACE_GENERATION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn workspace_changed() {
    WORKSPACE_GENERATION.fetch_add(1, Ordering::AcqRel);
}

pub(crate) fn should_start_fake_local_worker(recovery_mode: bool, reset_failed: bool) -> bool {
    should_start_fake_local_worker_value(
        recovery_mode,
        reset_failed,
        crate::discovery_credentials::fake_local_worker_enabled(),
    )
}

pub(crate) fn should_start_production_local_worker(
    recovery_mode: bool,
    reset_failed: bool,
) -> bool {
    should_start_production_local_worker_value(
        recovery_mode,
        reset_failed,
        crate::discovery_credentials::fake_local_worker_enabled(),
    )
}

fn should_start_production_local_worker_value(
    recovery_mode: bool,
    reset_failed: bool,
    fake_enabled: bool,
) -> bool {
    !recovery_mode && !reset_failed && !fake_enabled
}

fn should_start_fake_local_worker_value(
    recovery_mode: bool,
    reset_failed: bool,
    enabled: bool,
) -> bool {
    enabled && !recovery_mode && !reset_failed
}

fn workspace_generation() -> u64 {
    WORKSPACE_GENERATION.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::{should_start_fake_local_worker_value, should_start_production_local_worker_value};

    #[test]
    fn fake_worker_start_is_opt_in_and_recovery_safe() {
        assert!(!should_start_fake_local_worker_value(false, false, false));
        assert!(should_start_fake_local_worker_value(false, false, true));
        assert!(!should_start_fake_local_worker_value(true, false, true));
        assert!(!should_start_fake_local_worker_value(false, true, true));
    }

    #[test]
    fn production_worker_starts_by_default_and_is_recovery_safe() {
        assert!(should_start_production_local_worker_value(
            false, false, false
        ));
        assert!(!should_start_production_local_worker_value(
            true, false, false
        ));
        assert!(!should_start_production_local_worker_value(
            false, true, false
        ));
        assert!(!should_start_production_local_worker_value(
            false, false, true
        ));
    }
}
