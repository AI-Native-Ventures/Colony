use serde::Serialize;
use serde_json::Value;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};

use super::{WEB_ERROR_EVENT, WEB_FRAME_EVENT};

/// Per-session startup timings captured for one-shot first-frame reporting.
///
/// Every instant is taken with [`Instant::now`] from the moment the public
/// `start` path is invoked. The four deltas (`host_ready`, `cdp_connected`,
/// `page_initialized`, `first_frame`) are emitted once, on the first
/// `Page.screencastFrame`, and never again per session.
pub(super) struct SessionStartupTimings {
    pub(super) start: Instant,
    pub(super) host_ready: Instant,
    pub(super) cdp_connected: Instant,
    pub(super) page_initialized: Instant,
}

/// Log one-shot startup deltas (ms) for a session's first screencast frame.
pub(super) fn emit_startup_timings(session_id: &str, timings: &SessionStartupTimings) {
    let host_ready_ms = timings.host_ready.duration_since(timings.start).as_millis();
    let cdp_connected_ms = timings
        .cdp_connected
        .duration_since(timings.start)
        .as_millis();
    let page_initialized_ms = timings
        .page_initialized
        .duration_since(timings.start)
        .as_millis();
    let first_frame_ms = Instant::now().duration_since(timings.start).as_millis();
    eprintln!(
        "buzz-desktop: web session {session_id} startup: host_ready={host_ready_ms}ms cdp_connected={cdp_connected_ms}ms page_initialized={page_initialized_ms}ms first_frame={first_frame_ms}ms"
    );
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebFrameEvent {
    session_id: String,
    data: String,
    width: u32,
    height: u32,
    device_scale_factor: f64,
    offset_top: f64,
    scroll_offset_x: f64,
    scroll_offset_y: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebErrorEvent {
    session_id: String,
    error: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WebClosedEvent {
    pub(super) session_id: String,
    pub(super) error: Option<String>,
}

pub(super) fn emit_frame<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    event: &Value,
) -> Result<(), String> {
    let params = &event["params"];
    let data = params["data"]
        .as_str()
        .filter(|data| !data.is_empty())
        .ok_or_else(|| "screencast frame had no image data".to_string())?;
    let metadata = &params["metadata"];
    app.emit(
        WEB_FRAME_EVENT,
        WebFrameEvent {
            session_id: session_id.to_string(),
            data: data.to_string(),
            width: metadata["deviceWidth"].as_u64().unwrap_or(1) as u32,
            height: metadata["deviceHeight"].as_u64().unwrap_or(1) as u32,
            device_scale_factor: metadata["deviceScaleFactor"].as_f64().unwrap_or(1.0),
            offset_top: metadata["offsetTop"].as_f64().unwrap_or(0.0),
            scroll_offset_x: metadata["scrollOffsetX"].as_f64().unwrap_or(0.0),
            scroll_offset_y: metadata["scrollOffsetY"].as_f64().unwrap_or(0.0),
        },
    )
    .map_err(|error| format!("failed to emit web frame: {error}"))
}

pub(super) fn emit_error<R: Runtime>(app: &AppHandle<R>, session_id: &str, error: &str) {
    if let Err(emit_error) = app.emit(
        WEB_ERROR_EVENT,
        WebErrorEvent {
            session_id: session_id.to_string(),
            error: error.to_string(),
        },
    ) {
        eprintln!("buzz-desktop: failed to emit web error: {emit_error}");
    }
}
