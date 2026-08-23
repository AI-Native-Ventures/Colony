//! Stop managed agents on a community switch.
//!
//! The teardown half of "an agent belongs to exactly one community": leaving a
//! community stops that community's agents instead of letting their processes
//! run on against a relay nobody is viewing. Split from `runtime_commands.rs`
//! (file-size ratchet).

use tauri::{AppHandle, Emitter, Manager};

use super::{
    load_global_agent_config, load_managed_agents, load_personas, save_managed_agents,
    ManagedAgentRuntimeKey,
};

const STATUS_EVENT: &str = "managed-agent-runtime-status";

/// Agents stopped by [`stop_managed_agents_for_community`], reported back to
/// the caller (the community-switch teardown) for logging and UI refresh.
#[derive(serde::Serialize)]
pub struct CommunityAgentsStopped {
    /// The relay whose pairs were stopped.
    pub relay_url: String,
    /// Pubkeys of the agents whose runtimes were stopped.
    pub stopped_pubkeys: Vec<String>,
}

/// Stop every managed agent pinned to the given community's relay.
///
/// Called from the frontend's community-switch teardown BEFORE the new
/// community is applied. Best-effort per pair — a pair that fails to tear down
/// keeps its tracked state and surfaces through the returned error, while
/// pairs already stopped stay stopped.
#[tauri::command]
pub fn stop_managed_agents_for_community(
    relay_url: String,
    app: AppHandle,
) -> Result<CommunityAgentsStopped, String> {
    let state = app.state::<crate::app_state::AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;

    let stopped = {
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        super::runtime::stop_managed_agents_pinned_to(
            &app,
            &relay_url,
            &mut records,
            &mut runtimes,
        )?
    };

    // Surface each teardown as a status event so open agent cards flip to
    // stopped without a full roster refetch.
    if !stopped.is_empty() {
        let personas = load_personas(&app).unwrap_or_default();
        let global = load_global_agent_config(&app).unwrap_or_default();
        let runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        for pubkey in &stopped {
            let Some(record) = records.iter().find(|r| &r.pubkey == pubkey) else {
                continue;
            };
            if let Ok(key) = ManagedAgentRuntimeKey::new(record.pubkey.clone(), &relay_url) {
                let status = super::runtime_commands::status_for_with(
                    &app,
                    record,
                    &key,
                    runtimes.get(&key),
                    None,
                    super::runtime_commands::StatusInputs {
                        personas: &personas,
                        global: &global,
                    },
                );
                let _ = app.emit(STATUS_EVENT, &status);
            }
        }
    }

    save_managed_agents(&app, &records)?;
    Ok(CommunityAgentsStopped {
        relay_url,
        stopped_pubkeys: stopped,
    })
}
