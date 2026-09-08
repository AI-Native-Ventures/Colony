//! Read-only owner/community fencing for the first-job attach path.

use std::{path::Path, sync::atomic::Ordering};

use tauri::{AppHandle, Manager};

use crate::{
    app_state::AppState,
    company::transaction::is_event_id,
    managed_agents::{
        load_teams_readonly, owner_scope::effective_owner_pubkey, ManagedAgentRecord, TeamRecord,
    },
};

/// A first-job attach signs against existing approved local staffing only.
pub(super) struct AttachScope {
    owner: String,
    relay: String,
}

impl AttachScope {
    /// Both optional fields are required together; omitted fields preserve legacy attach behavior.
    pub(super) fn capture(
        expected_owner: Option<String>,
        expected_relay: Option<String>,
        actual_owner: &str,
        actual_relay: &str,
    ) -> Result<Option<Self>, String> {
        let (owner, relay) = match (expected_owner, expected_relay) {
            (None, None) => return Ok(None),
            (Some(owner), Some(relay)) if is_event_id(&owner) => (owner, relay),
            _ => return Err("A scoped task requires its account and business connection.".into()),
        };
        let scope = Self {
            owner,
            relay: canonical_relay(&relay)?,
        };
        scope.check_pair(actual_owner, actual_relay)?;
        Ok(Some(scope))
    }

    fn check_pair(&self, owner: &str, relay: &str) -> Result<(), String> {
        if owner != self.owner || canonical_relay(relay)? != self.relay {
            return Err("The account or business changed while preparing this job. Return to the original business and try again.".into());
        }
        Ok(())
    }

    /// Check signability and the active community again after each read boundary.
    pub(super) fn check(&self, state: &AppState) -> Result<(), String> {
        if state.reset_failed.load(Ordering::Acquire) {
            return Err("Account recovery must finish before preparing this job.".into());
        }
        let owner = state.signing_keys()?.public_key().to_hex();
        let relay = current_relay(state)?;
        self.check_pair(&owner, &relay)
    }

    /// Read the existing stores without key hydration, default writes or persona repair.
    pub(super) fn persona(&self, app: &AppHandle, pubkey: Option<&str>) -> Result<String, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("agents");
        self.persona_at(&directory, pubkey)
    }

    fn persona_at(&self, directory: &Path, pubkey: Option<&str>) -> Result<String, String> {
        // The ordinary loader hydrates secrets and preserves corrupt data in a
        // backup. A scoped attach needs neither: it must remain a pure read.
        let bytes = std::fs::read(directory.join("managed-agents.json")).map_err(|_| {
            "The approved team could not be read. Review your team and try again.".to_string()
        })?;
        let records: Vec<ManagedAgentRecord> = serde_json::from_slice(&bytes).map_err(|_| {
            "The approved team could not be read. Review your team and try again.".to_string()
        })?;
        let teams = load_teams_readonly(&directory.join("teams.json"))?;
        self.existing_persona(&records, &teams, pubkey)
    }

    fn existing_persona(
        &self,
        records: &[ManagedAgentRecord],
        teams: &[TeamRecord],
        pubkey: Option<&str>,
    ) -> Result<String, String> {
        let refused = || {
            "This job needs its existing approved Chief of Staff and business team. Review your team and try again.".to_string()
        };
        let pubkey = pubkey
            .filter(|pubkey| is_event_id(pubkey))
            .ok_or_else(refused)?;
        let agent = records
            .iter()
            .find(|agent| agent.pubkey == pubkey)
            .ok_or_else(refused)?;
        let persona = agent
            .persona_id
            .as_deref()
            .filter(|id| *id == "builtin:fizz")
            .ok_or_else(refused)?;
        if effective_owner_pubkey(agent).as_deref() != Some(self.owner.as_str())
            || canonical_relay(&agent.relay_url)? != self.relay
            || !records.iter().any(|definition| {
                definition.pubkey.is_empty()
                    && definition.slug.as_deref() == Some(persona)
                    && definition.is_active
            })
            || !teams.iter().any(|team| {
                team.relay_url
                    .as_deref()
                    .and_then(|relay| canonical_relay(relay).ok())
                    .as_deref()
                    == Some(self.relay.as_str())
                    && team.persona_ids.iter().any(|id| id == persona)
            })
        {
            return Err(refused());
        }
        Ok(persona.to_string())
    }
}

fn canonical_relay(relay: &str) -> Result<String, String> {
    buzz_core_pkg::relay::normalize_relay_url(relay).map_err(|error| error.to_string())
}

/// Unlike the legacy best-effort helper, a poisoned override never selects a fallback business.
pub(super) fn current_relay(state: &AppState) -> Result<String, String> {
    Ok(state
        .relay_url_override
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .unwrap_or_else(crate::relay::relay_ws_url))
}

#[cfg(test)]
#[path = "initiative_scope_tests.rs"]
mod tests;
