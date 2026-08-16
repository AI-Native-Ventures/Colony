//! Reading the agent roster for the community you are in.
//!
//! Split out of `agents.rs` when the roster became community-scoped: the
//! listing rules and the create/update/delete plumbing are separate concerns,
//! and `agents.rs` is at its size ceiling.

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        build_managed_agent_summary, current_instance_id, load_managed_agents, load_personas,
        save_managed_agents, sync_managed_agent_processes, ManagedAgentSummary,
    },
    relay::{agent_belongs_to_workspace, relay_ws_url_with_override},
};

// Async so the blocking body (disk reads of agent/persona records, per-agent
// process-liveness syscalls, and a possible save) runs on Tauri's worker pool
// via spawn_blocking instead of the main UI thread — it was a beachball on the
// agents menu mount and after every start/stop/edit refetch. State is re-derived
// from the owned AppHandle inside the closure because `State<'_, _>` is borrowed
// and `std::sync::MutexGuard` is not `Send`.
#[tauri::command]
pub async fn list_managed_agents(app: AppHandle) -> Result<Vec<ManagedAgentSummary>, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
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
        for pubkey in &exited_pubkeys {
            state.clear_agent_session_caches(pubkey);
        }

        let personas = load_personas(&app).unwrap_or_default();
        // One disk read for the whole list — build_managed_agent_summary takes
        // the config as a parameter precisely so this poll-every-5s call does
        // not re-read it per record.
        let global_config =
            crate::managed_agents::load_global_agent_config(&app).unwrap_or_default();
        // Only what is *shown* is scoped: see `agent_belongs_to_workspace`.
        let workspace_relay = relay_ws_url_with_override(&state);
        records
            .iter()
            .filter(|record| agent_belongs_to_workspace(&record.relay_url, &workspace_relay))
            .map(|record| {
                build_managed_agent_summary(&app, record, &runtimes, &personas, &global_config)
            })
            .collect()
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
