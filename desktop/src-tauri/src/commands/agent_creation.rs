use tauri::{AppHandle, State};

use super::agents::create_managed_agent_with_creation_request;
use crate::{
    app_state::AppState,
    managed_agents::{CreateManagedAgentRequest, CreateManagedAgentResponse, ManagedAgentRecord},
};

#[tauri::command]
pub async fn create_managed_agent(
    input: CreateManagedAgentRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CreateManagedAgentResponse, String> {
    create_managed_agent_with_creation_request(input, app, &state, None).await
}

/// Callers hold the managed-agent store lock through the subsequent save.
pub(crate) fn ensure_unique_creation_request(
    records: &[ManagedAgentRecord],
    creation_request_id: Option<&str>,
) -> Result<(), String> {
    let Some(request_id) = creation_request_id else {
        return Ok(());
    };
    if records
        .iter()
        .any(|record| record.creation_request_id.as_deref() == Some(request_id))
    {
        return Err("agent proposal creation was already applied".to_string());
    }
    Ok(())
}
