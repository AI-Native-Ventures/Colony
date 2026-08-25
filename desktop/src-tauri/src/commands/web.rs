//! Native command boundary for channel workspace web tabs.

use crate::app_state::AppState;
use crate::web::{WebKeyInput, WebMouseInput, WebStartRequest, WebStartResult, WebWheelInput};
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStartRequestWire {
    /// Existing DevTools endpoint, or `None` to launch through `buzz-browser`.
    pub endpoint: Option<String>,
    /// Optional page target id.
    pub target_id: Option<String>,
    /// Initial page URL.
    pub url: String,
}

/// Attach to or launch a browser and begin a real CDP screencast session.
#[tauri::command]
pub async fn workspace_web_start(
    request: WebStartRequestWire,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WebStartResult, String> {
    state
        .web_sessions
        .start(
            app,
            WebStartRequest {
                endpoint: request.endpoint,
                target_id: request.target_id,
                url: request.url,
            },
        )
        .await
}

/// Navigate the page in an existing web tab session.
#[tauri::command]
pub async fn workspace_web_navigate(
    session_id: String,
    url: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.navigate(&session_id, url).await
}

/// Navigate backward in the page history when an older entry exists.
#[tauri::command]
pub async fn workspace_web_back(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.back(&session_id).await
}

/// Navigate forward in the page history when a newer entry exists.
#[tauri::command]
pub async fn workspace_web_forward(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.forward(&session_id).await
}

/// Reload the page driven by an existing web session.
#[tauri::command]
pub async fn workspace_web_reload(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.reload(&session_id).await
}

/// Resize the CDP viewport to match the visible workspace surface.
#[tauri::command]
pub async fn workspace_web_resize(
    session_id: String,
    width: u32,
    height: u32,
    device_scale_factor: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .web_sessions
        .resize(&session_id, width, height, device_scale_factor)
        .await
}

/// Forward a pointer event to the page driven by an existing web session.
#[tauri::command]
pub async fn workspace_web_mouse(
    session_id: String,
    input: WebMouseInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.mouse(&session_id, input).await
}

/// Forward a wheel event to the page driven by an existing web session.
#[tauri::command]
pub async fn workspace_web_wheel(
    session_id: String,
    input: WebWheelInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.wheel(&session_id, input).await
}

/// Forward a key down/up event to the page driven by an existing web session.
#[tauri::command]
pub async fn workspace_web_key(
    session_id: String,
    input: WebKeyInput,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.key(&session_id, input).await
}

/// Forward text through CDP's trusted text-input operation.
#[tauri::command]
pub async fn workspace_web_text(
    session_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.text(&session_id, text).await
}

/// Close a web tab and wait for its CDP task to finish.
#[tauri::command]
pub async fn workspace_web_close(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.web_sessions.close(&session_id).await
}

/// Close every web tab before a community boundary or app exit.
#[tauri::command]
pub async fn workspace_web_close_all(state: State<'_, AppState>) -> Result<(), String> {
    state.web_sessions.close_all_async().await
}
