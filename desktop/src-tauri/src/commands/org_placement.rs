//! Persisting an owner's org placement into the agent's own record.
//!
//! `publishManagedAgentRankHead` publishes a kind:30177 head carrying `tier`
//! and a `manager` tag. It does not touch the local record, and the device
//! rebuilds that head from the record on every rename, parallelism change,
//! persona relink and restart. So a placement survived until the next
//! rebuild and then vanished: the roster fell back to UNASSIGNED and the
//! Chief of Staff read as an ordinary team lead.
//!
//! Carrying `tier` and `manager` in the projection (#516, #583) is only half
//! of it. The record has to learn them in the first place, and the only place
//! that knows is the publish the owner just made.

use tauri::{AppHandle, State};

use crate::{
    app_state::AppState,
    managed_agents::storage::{load_managed_agents, save_managed_agents},
};

/// Record the rank and reporting line the owner just published.
///
/// `manager` of `None` clears the reporting line, because that is what the org
/// dialog means by leaving it empty: this call always follows a publish the
/// owner made, so absent here is a decision rather than a missing field. That
/// is the opposite of the INBOUND rule, where absent means "not carried" and
/// must never read as a demotion.
#[tauri::command]
pub async fn record_org_placement(
    app: AppHandle,
    pubkey: String,
    tier: Option<String>,
    manager: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let normalized = pubkey.trim().to_lowercase();
    if normalized.is_empty() {
        return Err("an org placement needs the agent's pubkey".to_string());
    }

    let _guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let mut records = load_managed_agents(&app)?;
    let Some(record) = records
        .iter_mut()
        .find(|record| record.pubkey.trim().to_lowercase() == normalized)
    else {
        // Not an error: an agent can be placed on the chart before its record
        // exists locally, and the inbound head will carry the placement back.
        return Ok(());
    };

    record.tier = tier.filter(|value| !value.trim().is_empty());
    record.manager = manager
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    save_managed_agents(&app, &records)
}
