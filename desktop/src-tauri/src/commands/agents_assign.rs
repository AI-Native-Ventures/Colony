//! Assign community-less agents to the community they belong to.
//!
//! Builds before the community boundary landed minted records with a blank
//! `relay_url`, and the boundary treats blank as "belongs to whoever is
//! asking" so none of them stop working on upgrade. That is deliberately a
//! transitional state: a blank-pin agent still shows up in every community's
//! roster, and deleting it in one removes it from all of them, because there
//! is only one record. Assigning is how the user converts a shared record into
//! one that lives in exactly one community.
//!
//! Nothing infers the answer. Pair logs on a real install show these records
//! genuinely ran in several communities, so the disk holds no fact about where
//! they belong; the user picks.

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        build_managed_agent_summary, current_instance_id, load_managed_agents, load_personas,
        save_managed_agents, stop_managed_agent_process, sync_managed_agent_processes,
        ManagedAgentSummary,
    },
    relay::relay_ws_url_with_override,
    util::now_iso,
};

/// Pin each named agent to the active community.
///
/// Refuses an agent that already carries a pin, including one pinned to the
/// active community. Reassignment is not a rename: an agent has published
/// under a community's relay, holds channel membership there, and appears in
/// other members' rosters, so moving one is a migration this command must not
/// silently perform. Only blank -> assigned is offered.
///
/// Every runtime pair for the agent is drained first. An unassigned agent's
/// pair key is derived from whichever workspace it was started in, so pinning
/// it changes that key; without the stop, the live process would keep running
/// under a key nothing looks up again. The user restarts it in its own
/// community afterwards.
///
/// All-or-nothing on validation: the whole batch is checked before anything is
/// written, so a bulk "assign everything here" either lands or reports which
/// agent blocked it, never half-applies.
///
/// Not handled here: the agent's identity may already be published on other
/// communities' relays from when it ran there. Assignment stops it running
/// there; it does not retract what was published.
#[tauri::command]
pub async fn assign_managed_agents_to_community(
    pubkeys: Vec<String>,
    app: AppHandle,
) -> Result<Vec<ManagedAgentSummary>, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        if pubkeys.is_empty() {
            return Err("no agents given to assign".to_string());
        }
        let state = app.state::<AppState>();
        let workspace_relay = relay_ws_url_with_override(&state);
        if workspace_relay.trim().is_empty() {
            return Err("no active community to assign to".to_string());
        }

        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;

        let (sync_changed, exited_pubkeys) =
            sync_managed_agent_processes(&mut records, &mut runtimes, &current_instance_id(&app));
        if sync_changed {
            save_managed_agents(&app, &records)?;
        }
        for exited in &exited_pubkeys {
            state.clear_agent_session_caches(exited);
        }

        // Validate the whole batch before mutating anything.
        for pubkey in &pubkeys {
            let record = records
                .iter()
                .find(|record| &record.pubkey == pubkey)
                .ok_or_else(|| format!("agent {pubkey} not found"))?;
            if !record.relay_url.trim().is_empty() {
                return Err(format!(
                    "agent {} already belongs to {}, and an agent cannot change community",
                    record.name, record.relay_url
                ));
            }
        }

        let now = now_iso();
        for pubkey in &pubkeys {
            let index = records
                .iter()
                .position(|record| &record.pubkey == pubkey)
                .ok_or_else(|| format!("agent {pubkey} not found"))?;
            // Drain every pair before the key moves under the process.
            stop_managed_agent_process(&app, &mut records[index], &mut runtimes)?;
            state.clear_agent_session_caches(pubkey);
            records[index].relay_url = workspace_relay.clone();
            records[index].updated_at = now.clone();
        }
        save_managed_agents(&app, &records)?;

        let personas = load_personas(&app).unwrap_or_default();
        let global_config =
            crate::managed_agents::load_global_agent_config(&app).unwrap_or_default();
        records
            .iter()
            .filter(|record| pubkeys.contains(&record.pubkey))
            .map(|record| {
                build_managed_agent_summary(&app, record, &runtimes, &personas, &global_config)
            })
            .collect()
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}
