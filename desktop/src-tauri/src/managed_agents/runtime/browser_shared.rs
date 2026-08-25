//! T5: forward the DevTools endpoint of the human's open workspace tab into
//! the spawned agent's env, so its browser MCP server attaches to the tab
//! the human is already watching instead of launching an invisible second
//! browser. See `WebManager::shared_endpoint` for the no-arbitration,
//! single-tab-only contract this reads.

use tauri::{AppHandle, Manager};

/// `None` when desktop has no live workspace web session right now, or more
/// than one -- either way the agent falls back to launching its own browser.
pub(super) fn resolve(app: &AppHandle) -> Option<(String, String)> {
    app.state::<crate::app_state::AppState>()
        .web_sessions
        .shared_endpoint()
}

pub(super) fn apply_env(command: &mut std::process::Command, shared: &Option<(String, String)>) {
    match shared {
        Some((endpoint, target_id)) => {
            command.env("BUZZ_ACP_BROWSER_ENDPOINT", endpoint);
            command.env("BUZZ_ACP_BROWSER_TARGET_ID", target_id);
        }
        None => {
            command.env("BUZZ_ACP_BROWSER_ENDPOINT", "");
            command.env("BUZZ_ACP_BROWSER_TARGET_ID", "");
        }
    }
}
