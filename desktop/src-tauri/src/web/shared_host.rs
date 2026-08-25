//! Refcounted sharing of one launched `BrowserHost` across workspace web tabs.
//!
//! Every session that connects without an explicit DevTools `endpoint` used
//! to launch its own Chromium (`web.rs`'s `start_inner` calling `open_host`).
//! Measured cold launch is ~7s versus ~250ms to attach to an already-running
//! host and open a fresh CDP target, so that per-tab launch dominated first
//! paint. This module launches Chromium once, hands every later session an
//! attached (non-owning) `BrowserHost` pointed at the same DevTools endpoint
//! plus a fresh target, and kills the shared process only when the last
//! session still using it releases its claim.

use std::sync::{Arc, Mutex, MutexGuard};

use buzz_browser_pkg::host::{self, BrowserHost};
use buzz_browser_pkg::BrowserError;

pub(super) struct SharedLaunchedHost {
    host: BrowserHost,
    refcount: usize,
}

/// `None` until the first launch-path session arrives; cleared back to `None`
/// (dropping the owning `BrowserHost`, which kills the process) once the last
/// claim on it is released.
pub(super) type SharedHostSlot = Arc<Mutex<Option<SharedLaunchedHost>>>;

fn lock(slot: &SharedHostSlot) -> MutexGuard<'_, Option<SharedLaunchedHost>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Bump the refcount and hand back the existing endpoint, if a host is
/// already running. Returns `None` when the caller must launch one.
fn reuse_existing(slot: &SharedHostSlot) -> Option<String> {
    let mut guard = lock(slot);
    let shared = guard.as_mut()?;
    shared.refcount += 1;
    Some(shared.host.base_url().to_string())
}

/// Install a freshly launched host as the shared one, or - if a concurrent
/// start already installed one first - join it and tear down the redundant
/// launch instead of leaking it.
fn install_or_join(slot: &SharedHostSlot, launched: BrowserHost) -> String {
    let mut guard = lock(slot);
    if let Some(shared) = guard.as_mut() {
        shared.refcount += 1;
        let endpoint = shared.host.base_url().to_string();
        drop(guard);
        drop(launched); // owning Drop kills the redundant browser process
        endpoint
    } else {
        let endpoint = launched.base_url().to_string();
        *guard = Some(SharedLaunchedHost {
            host: launched,
            refcount: 1,
        });
        endpoint
    }
}

/// Release one session's claim on the shared host. Drops (and so kills) the
/// shared browser once the last claim is released.
pub(super) fn release(slot: &SharedHostSlot) {
    let mut guard = lock(slot);
    let Some(shared) = guard.as_mut() else {
        return;
    };
    shared.refcount = shared.refcount.saturating_sub(1);
    if shared.refcount == 0 {
        *guard = None;
    }
}

/// Holds a claim on the shared host until [`SharedHostReservation::keep`] is
/// called. Dropping it unclaimed (a failed attach/connect after acquiring)
/// releases the claim instead of leaking the refcount.
pub(super) struct SharedHostReservation {
    slot: SharedHostSlot,
    armed: bool,
}

impl SharedHostReservation {
    /// Hand the claim to its long-lived owner (the `WebSession`).
    pub(super) fn keep(mut self) -> SharedHostSlot {
        self.armed = false;
        self.slot.clone()
    }
}

impl Drop for SharedHostReservation {
    fn drop(&mut self) {
        if self.armed {
            release(&self.slot);
        }
    }
}

/// Get (launching if needed) the shared host's endpoint and attach a session
/// to it. Callers open their own CDP target on the returned host (via
/// `BrowserHost::new_target`) the same way the explicit-endpoint path
/// resolves a target after `open_host`, so first-frame timing stays
/// comparable across both paths.
pub(super) async fn acquire_host(
    slot: &SharedHostSlot,
) -> Result<(BrowserHost, SharedHostReservation), BrowserError> {
    let endpoint = match reuse_existing(slot) {
        Some(endpoint) => endpoint,
        None => {
            let launched = host::launch(&host::HostConfig::default()).await?;
            install_or_join(slot, launched)
        }
    };
    let reservation = SharedHostReservation {
        slot: slot.clone(),
        armed: true,
    };
    let attached = host::attach(&endpoint).await?;
    Ok((attached, reservation))
}

/// Test-only introspection: the shared browser's PID, if one is running.
/// Every session now attaches rather than owning its process directly (see
/// module docs), so tests that used to read a session's own `browser_pid`
/// check the manager's shared host here instead.
#[cfg(test)]
pub(super) fn pid(slot: &SharedHostSlot) -> Option<u32> {
    lock(slot)
        .as_ref()
        .and_then(|shared| shared.host.process_id())
}
