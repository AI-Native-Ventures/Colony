//! One short publication boundary shared by every native writer and scoped launch.

use std::sync::{Mutex, MutexGuard};

use super::GlobalAgentConfig;

static PUBLICATION: Mutex<()> = Mutex::new(());

/// Hold only for local disk publication or the final process commit, never network I/O.
pub(crate) fn lock() -> Result<MutexGuard<'static, ()>, String> {
    PUBLICATION
        .lock()
        .map_err(|_| "Agent defaults could not be locked. Restart Colony and retry.".into())
}

/// Keep the comparison and the caller's spawn/register operation in one publication turn.
pub(crate) fn lock_expected(
    expected: &GlobalAgentConfig,
    read: impl FnOnce() -> Result<GlobalAgentConfig, String>,
) -> Result<MutexGuard<'static, ()>, String> {
    let guard = lock()?;
    if read()? != *expected {
        return Err(
            "Power settings changed again. Review the saved connection and try again.".into(),
        );
    }
    Ok(guard)
}

#[cfg(test)]
mod tests;
