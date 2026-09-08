//! Optional owner fencing for explicit first-job runtime starts.

use std::process::Child;

use crate::{app_state::AppState, managed_agents::terminate_process};

/// A caller-specified owner is immutable throughout blocking spawn work.
pub(super) struct StartOwnerGuard(Option<String>);

impl StartOwnerGuard {
    /// Capture only a valid, currently signable owner; legacy calls remain opt-out.
    pub(super) fn capture(
        expected: Option<String>,
        current: impl FnOnce() -> Result<String, String>,
    ) -> Result<Self, String> {
        if expected.as_ref().is_some_and(|owner| {
            owner.len() != 64
                || !owner
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err("expected owner must be 64 lowercase hexadecimal characters".into());
        }
        let guard = Self(expected);
        guard.check_current(current)?;
        Ok(guard)
    }

    /// The captured owner is passed to spawn instead of rereading mutable keys.
    pub(super) fn owner(&self) -> Option<&str> {
        self.0.as_deref()
    }

    /// Check after each blocking boundary without changing legacy callers.
    pub(super) fn check_current(
        &self,
        current: impl FnOnce() -> Result<String, String>,
    ) -> Result<(), String> {
        if let Some(expected) = self.owner() {
            if current()? != expected {
                return Err("The account changed while starting this teammate. Return to the original account and retry.".into());
            }
        }
        Ok(())
    }

    /// A first job cannot adopt another owner's or an unowned legacy record.
    pub(super) fn check_record(&self, record_owner: Option<&str>) -> Result<(), String> {
        if let Some(expected) = self.owner() {
            if !record_owner.is_some_and(|owner| owner.eq_ignore_ascii_case(expected)) {
                return Err("This teammate is not approved for the selected account.".into());
            }
        }
        Ok(())
    }
}

/// Recovery/reset states never provide an owner for an opted-in runtime start.
pub(super) fn current_owner(state: &AppState) -> Result<String, String> {
    if state
        .reset_failed
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("Account recovery must finish before starting a teammate.".into());
    }
    state.signing_keys().map(|keys| keys.public_key().to_hex())
}

/// Refusing a post-spawn check must kill and reap the unregistered child.
pub(super) fn check_spawned<T>(result: Result<T, String>, child: &mut Child) -> Result<T, String> {
    if let Err(error) = result {
        if terminate_process(child.id()).is_err() {
            let _ = child.kill();
        }
        child.wait().map_err(|cleanup| {
            format!("{error} The stopped teammate could not be reaped: {cleanup}")
        })?;
        return Err(error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> String {
        "a".repeat(64)
    }

    #[test]
    fn captured_owner_rejects_change_and_unavailable_signing() {
        let guard = StartOwnerGuard::capture(Some(owner()), || Ok(owner())).unwrap();
        assert!(guard.check_current(|| Ok("b".repeat(64))).is_err());
        assert!(guard
            .check_current(|| Err("identity locked".into()))
            .is_err());
        assert_eq!(guard.owner(), Some(owner().as_str()));
    }

    #[test]
    fn capture_refuses_malformed_wrong_and_unavailable_owner() {
        for expected in ["".into(), "a".repeat(63), "A".repeat(64), "g".repeat(64)] {
            assert!(StartOwnerGuard::capture(Some(expected), || Ok(owner())).is_err());
        }
        assert!(StartOwnerGuard::capture(Some(owner()), || Ok("b".repeat(64))).is_err());
        assert!(StartOwnerGuard::capture(Some(owner()), || Err("identity lost".into())).is_err());
    }

    #[test]
    fn guard_requires_known_matching_record_owner() {
        let guard = StartOwnerGuard::capture(Some(owner()), || Ok(owner())).unwrap();
        assert!(guard.check_record(None).is_err());
        assert!(guard.check_record(Some(&"b".repeat(64))).is_err());
        assert!(guard.check_record(Some(&owner())).is_ok());
    }

    #[test]
    fn legacy_start_does_not_add_identity_or_record_requirements() {
        let guard =
            StartOwnerGuard::capture(None, || panic!("legacy path must not read signing state"))
                .unwrap();
        assert_eq!(guard.owner(), None);
        assert!(guard
            .check_current(|| panic!("legacy path must not read signing state"))
            .is_ok());
        assert!(guard.check_record(None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn changed_owner_after_spawn_reaps_the_actual_child() {
        use std::os::unix::process::CommandExt;
        let guard = StartOwnerGuard::capture(Some(owner()), || Ok(owner())).unwrap();
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0)
            .spawn()
            .unwrap();
        let refused = guard.check_current(|| Ok("b".repeat(64)));
        let result = check_spawned(refused, &mut child);
        let reaped = child.try_wait().unwrap().is_some();
        if !reaped {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(result.is_err());
        assert!(reaped);
    }
}
