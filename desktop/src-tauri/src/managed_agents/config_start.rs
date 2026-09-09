//! A scoped Power restart carries its selected defaults through blocking spawn work.

use std::sync::MutexGuard;

use tauri::AppHandle;

use super::{
    global_config::publication, load_global_agent_config, load_personas,
    spawn_snapshot::prospective_spawn_config_snapshot, CredentialMode, GlobalAgentConfig,
    ManagedAgentRecord,
};
use crate::app_state::AppState;

/// Immutable context of an explicit Power adoption. Other starts remain opt-out.
pub(crate) struct ConfigStartFence {
    pub(crate) global: GlobalAgentConfig,
    pub(crate) owner: String,
    pub(crate) relay: String,
}

/// Context locks precede runtime/store/publication locks, and are never held for network I/O.
pub(crate) struct ConfigStartContext<'a> {
    _community: tokio::sync::RwLockReadGuard<'a, ()>,
    _identity: MutexGuard<'a, ()>,
}

impl ConfigStartFence {
    /// Freeze the captured signing owner and active relay for a local commit point.
    pub(crate) fn lock_context<'a>(
        &self,
        state: &'a AppState,
    ) -> Result<ConfigStartContext<'a>, String> {
        let community = state.community_operation_lock.blocking_read();
        let identity = state.identity_mutation.lock().map_err(|e| e.to_string())?;
        if state
            .reset_failed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err("Account recovery must finish before starting a teammate.".into());
        }
        let owner = state.signing_keys()?.public_key().to_hex();
        let relay = state
            .relay_url_override
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .unwrap_or_else(crate::relay::relay_ws_url);
        if owner != self.owner
            || buzz_core_pkg::relay::normalize_relay_url(&relay).map_err(|e| e.to_string())?
                != self.relay
        {
            return Err("The account or business changed while starting this teammate. Return to the original business and retry.".into());
        }
        Ok(ConfigStartContext {
            _community: community,
            _identity: identity,
        })
    }

    /// Compare and retain publication ownership until spawn or registration completes.
    pub(crate) fn lock_config(&self, app: &AppHandle) -> Result<MutexGuard<'static, ()>, String> {
        publication::lock_expected(&self.global, || load_global_agent_config(app))
    }

    /// A competing live pair is only success when it really adopted this Power choice.
    pub(crate) fn check_process(
        &self,
        app: &AppHandle,
        record: &ManagedAgentRecord,
        actual: &super::spawn_snapshot::SpawnConfigSnapshot,
        has_credits: bool,
        setup_mode: bool,
    ) -> Result<(), String> {
        let personas = load_personas(app)?;
        let expected =
            prospective_spawn_config_snapshot(record, &personas, &[], &self.relay, &self.global);
        if !power_matches(&expected, actual, has_credits, setup_mode) {
            return Err("The running teammate has a different Power connection. Review it in Agents and retry.".into());
        }
        Ok(())
    }
}

fn power_matches(
    expected: &super::spawn_snapshot::SpawnConfigSnapshot,
    actual: &super::spawn_snapshot::SpawnConfigSnapshot,
    has_credits: bool,
    setup_mode: bool,
) -> bool {
    !setup_mode
        && actual.command == expected.command
        && actual.args == expected.args
        && actual.mcp_command == expected.mcp_command
        && actual.env == expected.env
        && actual.model == expected.model
        && actual.provider == expected.provider
        && actual.credential_mode == expected.credential_mode
        && has_credits == (expected.credential_mode == CredentialMode::ColonyCredits)
}

#[cfg(test)]
mod tests;
