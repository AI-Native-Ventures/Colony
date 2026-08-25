//! T5: hand the agent's browser MCP server the DevTools endpoint of the
//! human's open workspace tab, so agent actions land in the tab the human is
//! watching instead of an invisible second browser. Data only -- this module
//! does not decide how the MCP server uses it and does not arbitrate between
//! concurrent controllers.

use super::WebManager;

/// DevTools endpoint and page target id captured at session start, from the
/// same `BrowserHost` / `TargetInfo` values `WebManager::start` already
/// resolves for the frontend's `WebStartResult`.
#[derive(Debug, Clone, Default)]
pub struct SharedTabInfo {
    pub endpoint: String,
    pub target_id: String,
}

impl WebManager {
    /// The endpoint and target id of the human's tab, when exactly one
    /// workspace web session is live. `None` with zero sessions (agent falls
    /// back to launching its own browser) and `None` with more than one --
    /// this ticket does not disambiguate which of several open tabs the
    /// agent should share, only the common single-tab case.
    pub fn shared_endpoint(&self) -> Option<(String, String)> {
        let sessions = self.sessions.lock().ok()?;
        let mut values = sessions.values();
        let session = values.next()?;
        if values.next().is_some() {
            return None;
        }
        Some((
            session.shared.endpoint.clone(),
            session.shared.target_id.clone(),
        ))
    }
}
