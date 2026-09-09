use tauri::{AppHandle, Manager};

use crate::managed_agents::{
    config_start::ConfigStartFence, ManagedAgentProcess, ManagedAgentRecord,
};

/// Spawn an agent without holding record or runtime locks across provider/lease I/O.
/// The caller owns registration. `owner_hex` is the legacy NIP-OA owner fallback.
pub fn spawn_agent_child(
    app: &AppHandle,
    record: &ManagedAgentRecord,
    relay_url: &str,
    lazy: bool,
    owner_hex: Option<&str>,
) -> Result<ManagedAgentProcess, String> {
    super::spawn_agent_child_with_lease(app, record, relay_url, lazy, owner_hex, None)
}

/// Preserve an explicit Power selection without holding its guards during preparation.
pub(crate) fn spawn_agent_child_with_config(
    app: &AppHandle,
    record: &ManagedAgentRecord,
    relay_url: &str,
    lazy: bool,
    owner_hex: Option<&str>,
    fence: Option<&ConfigStartFence>,
) -> Result<ManagedAgentProcess, String> {
    super::spawn_agent_child_inner(app, record, relay_url, lazy, owner_hex, None, fence)
}

/// Only the final OS spawn runs under the same locks as config publication/context changes.
pub(super) fn spawn<T>(
    app: &AppHandle,
    fence: Option<&ConfigStartFence>,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<crate::app_state::AppState>();
    let _context = fence.map(|fence| fence.lock_context(&state)).transpose()?;
    let _publication = fence.map(|fence| fence.lock_config(app)).transpose()?;
    operation()
}
