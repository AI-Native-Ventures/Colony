//! Runtime-owned CDP sessions backing channel workspace web tabs.
//!
//! The browser engine remains `buzz-browser`: this module only owns the Tauri
//! lifecycle and forwards the page's CDP screencast/input traffic to the
//! frontend. A session owns its host and websocket task until an explicit tab
//! close, community reset, app shutdown, or connection failure ends it.

use buzz_browser_pkg::{
    cdp::CdpClient,
    mcp::{open_host, pick_target, ConnectParams},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

/// Event emitted for each acknowledged CDP screencast frame.
pub const WEB_FRAME_EVENT: &str = "workspace-web-frame";
/// Event emitted when a web session encounters a terminal error.
pub const WEB_ERROR_EVENT: &str = "workspace-web-error";
/// Event emitted when a web session closes, optionally with an error.
pub const WEB_CLOSED_EVENT: &str = "workspace-web-closed";

const MAX_COMMAND_TEXT: usize = 64 * 1024;
const MAX_COORDINATE: f64 = 100_000.0;
const SESSION_POLL: Duration = Duration::from_millis(100);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct WebStartRequest {
    /// Existing DevTools endpoint; `None` launches through `buzz-browser`.
    pub endpoint: Option<String>,
    /// Optional Chromium binary used when launching a new browser.
    pub binary: Option<String>,
    /// Whether a launched browser should run headlessly.
    pub headless: bool,
    /// Optional page target id to attach to.
    pub target_id: Option<String>,
    /// Initial page URL.
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebStartResult {
    /// Identifier used by subsequent web workspace commands.
    pub session_id: String,
    /// The attached page target id.
    pub target_id: String,
    /// Normalized initial URL.
    pub url: String,
    /// Whether the session owns a browser process that it may terminate.
    pub owns_browser_process: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMouseInput {
    /// CDP mouse event type: move, press, or release.
    pub event_type: String,
    /// Page-space horizontal coordinate.
    pub x: f64,
    /// Page-space vertical coordinate.
    pub y: f64,
    /// Optional CDP mouse button.
    pub button: Option<String>,
    /// Optional click count for press/release events.
    pub click_count: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebWheelInput {
    /// Page-space horizontal coordinate.
    pub x: f64,
    /// Page-space vertical coordinate.
    pub y: f64,
    /// Horizontal wheel delta.
    pub delta_x: f64,
    /// Vertical wheel delta.
    pub delta_y: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebKeyInput {
    /// CDP key event type: `keyDown` or `keyUp`.
    pub event_type: String,
    /// Logical key value.
    pub key: String,
    /// Optional physical key code.
    pub code: Option<String>,
    /// Optional text associated with a key-down event.
    pub text: Option<String>,
    /// CDP modifier bitmask.
    pub modifiers: Option<u8>,
    /// Optional Windows virtual key code.
    pub windows_virtual_key_code: Option<i64>,
}

enum WebCommand {
    Navigate {
        url: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Mouse {
        input: WebMouseInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Wheel {
        input: WebWheelInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Key {
        input: WebKeyInput,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Text {
        text: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

struct WebSession {
    commands: mpsc::Sender<WebCommand>,
    stop_requested: Arc<AtomicBool>,
    done: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

/// The native owner for all live workspace web tabs.
#[derive(Default)]
pub struct WebManager {
    sessions: Mutex<HashMap<String, Arc<WebSession>>>,
}

impl WebManager {
    /// Attach to or launch a browser through the shared `buzz-browser` path.
    pub async fn start(
        &self,
        app: AppHandle,
        request: WebStartRequest,
    ) -> Result<WebStartResult, String> {
        let url = normalize_url(&request.url)?;
        let params = ConnectParams {
            binary: request.binary,
            headless: Some(request.headless),
            endpoint: request
                .endpoint
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            target_id: request.target_id,
        };
        let host = open_host(&params)
            .await
            .map_err(|error| error.to_string())?;
        let owns_browser_process = host.owns_browser_process();
        let targets = host
            .list_targets()
            .await
            .map_err(|error| error.to_string())?;
        let target = pick_target(&targets, params.target_id.as_deref())
            .map_err(|error| error.to_string())?
            .clone();
        let mut client = CdpClient::connect(&target.ws_url)
            .await
            .map_err(|error| error.to_string())?;

        initialize_page(&mut client, &url)
            .await
            .map_err(|error| error.to_string())?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (commands, receiver) = mpsc::channel(64);
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let session = Arc::new(WebSession {
            commands,
            stop_requested: Arc::clone(&stop_requested),
            done: Mutex::new(Some(done_receiver)),
        });

        self.sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))?
            .insert(session_id.clone(), Arc::clone(&session));

        tokio::spawn(run_session(
            app,
            session_id.clone(),
            host,
            client,
            stop_requested,
            receiver,
            done_sender,
        ));

        Ok(WebStartResult {
            session_id,
            target_id: target.id,
            url,
            owns_browser_process,
        })
    }

    /// Navigate the page driven by a web tab.
    pub async fn navigate(&self, session_id: &str, url: String) -> Result<(), String> {
        let url = normalize_url(&url)?;
        self.dispatch(session_id, |reply| WebCommand::Navigate { url, reply })
            .await
    }

    /// Forward a mouse move/press/release event to the active page.
    pub async fn mouse(&self, session_id: &str, input: WebMouseInput) -> Result<(), String> {
        validate_mouse(&input)?;
        self.dispatch(session_id, |reply| WebCommand::Mouse { input, reply })
            .await
    }

    /// Forward a wheel event to the active page.
    pub async fn wheel(&self, session_id: &str, input: WebWheelInput) -> Result<(), String> {
        validate_wheel(&input)?;
        self.dispatch(session_id, |reply| WebCommand::Wheel { input, reply })
            .await
    }

    /// Forward a key down/up event to the active page.
    pub async fn key(&self, session_id: &str, input: WebKeyInput) -> Result<(), String> {
        validate_key(&input)?;
        self.dispatch(session_id, |reply| WebCommand::Key { input, reply })
            .await
    }

    /// Forward text through CDP's trusted `Input.insertText` operation.
    pub async fn text(&self, session_id: &str, text: String) -> Result<(), String> {
        validate_text(&text)?;
        self.dispatch(session_id, |reply| WebCommand::Text { text, reply })
            .await
    }

    /// Close one web tab and wait for its CDP task and host to be dropped.
    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        let session = self.remove(session_id)?;
        if let Some(session) = session {
            stop_and_wait(session).await?;
        }
        Ok(())
    }

    /// Close every web tab asynchronously during a community reset.
    pub async fn close_all_async(&self) -> Result<(), String> {
        for session in self.drain()? {
            stop_and_wait(session).await?;
        }
        Ok(())
    }

    /// Close every web tab synchronously during app shutdown.
    pub fn close_all(&self) {
        let sessions = match self.drain() {
            Ok(sessions) => sessions,
            Err(error) => {
                eprintln!("buzz-desktop: failed to drain web sessions: {error}");
                Vec::new()
            }
        };
        for session in sessions {
            session.stop_requested.store(true, Ordering::SeqCst);
            wait_for_done(&session);
        }
    }

    async fn dispatch<F>(&self, session_id: &str, make_command: F) -> Result<(), String>
    where
        F: FnOnce(oneshot::Sender<Result<(), String>>) -> WebCommand,
    {
        let session = self
            .sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "web session was not found".to_string())?;
        let (reply, response) = oneshot::channel();
        session
            .commands
            .send(make_command(reply))
            .await
            .map_err(|_| "web session task has exited".to_string())?;
        response
            .await
            .map_err(|_| "web session task has exited".to_string())?
    }

    fn remove(&self, session_id: &str) -> Result<Option<Arc<WebSession>>, String> {
        self.sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))
            .map(|mut sessions| sessions.remove(session_id))
    }

    fn drain(&self) -> Result<Vec<Arc<WebSession>>, String> {
        self.sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))
            .map(|mut sessions| sessions.drain().map(|(_, session)| session).collect())
    }
}

async fn stop_and_wait(session: Arc<WebSession>) -> Result<(), String> {
    session.stop_requested.store(true, Ordering::SeqCst);
    tokio::task::spawn_blocking(move || wait_for_done(&session))
        .await
        .map_err(|error| format!("web session shutdown task failed: {error}"))
}

fn wait_for_done(session: &WebSession) {
    let receiver = session.done.lock().ok().and_then(|mut done| done.take());
    if let Some(receiver) = receiver {
        if receiver.recv_timeout(CLOSE_TIMEOUT).is_err() {
            eprintln!("buzz-desktop: timed out stopping web session task");
        }
    }
}

async fn initialize_page(
    client: &mut CdpClient,
    url: &str,
) -> Result<(), buzz_browser_pkg::BrowserError> {
    client.send_command("Page.enable", json!({})).await?;
    client
        .send_command(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": 85,
                "maxWidth": 1600,
                "maxHeight": 1200,
                "everyNthFrame": 1
            }),
        )
        .await?;
    if url != "about:blank" {
        client
            .send_command("Page.navigate", json!({ "url": url }))
            .await?;
    }
    Ok(())
}

async fn run_session(
    app: AppHandle,
    session_id: String,
    _host: buzz_browser_pkg::host::BrowserHost,
    mut client: CdpClient,
    stop_requested: Arc<AtomicBool>,
    mut commands: mpsc::Receiver<WebCommand>,
    done_sender: std::sync::mpsc::Sender<()>,
) {
    let result = run_session_loop(
        &app,
        &session_id,
        &mut client,
        &stop_requested,
        &mut commands,
    )
    .await;
    if let Err(error) = &result {
        emit_error(&app, &session_id, error);
    }
    let _ = app.emit(
        WEB_CLOSED_EVENT,
        WebClosedEvent {
            session_id,
            error: result.err(),
        },
    );
    let _ = done_sender.send(());
}

async fn run_session_loop(
    app: &AppHandle,
    session_id: &str,
    client: &mut CdpClient,
    stop_requested: &AtomicBool,
    commands: &mut mpsc::Receiver<WebCommand>,
) -> Result<(), String> {
    loop {
        if stop_requested.load(Ordering::SeqCst) {
            let _ = tokio::time::timeout(
                CLOSE_TIMEOUT,
                client.send_command("Page.stopScreencast", json!({})),
            )
            .await;
            return Ok(());
        }

        match tokio::time::timeout(SESSION_POLL, client.next_event()).await {
            Ok(Ok(event)) => {
                if event["method"].as_str() == Some("Page.screencastFrame") {
                    emit_frame(app, session_id, &event)?;
                    let frame_id = event["params"]["sessionId"]
                        .as_u64()
                        .ok_or_else(|| "screencast frame had no session id".to_string())?;
                    client
                        .send_command("Page.screencastFrameAck", json!({ "sessionId": frame_id }))
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => {}
        }

        while let Ok(command) = commands.try_recv() {
            let result = execute_command(client, command).await;
            if let Err(error) = result {
                return Err(error);
            }
        }
    }
}

async fn execute_command(client: &mut CdpClient, command: WebCommand) -> Result<(), String> {
    match command {
        WebCommand::Navigate { url, reply } => {
            let result = client
                .send_command("Page.navigate", json!({ "url": url }))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Mouse { input, reply } => {
            let mut params = json!({
                "type": input.event_type,
                "x": input.x,
                "y": input.y,
                "button": input.button.unwrap_or_else(|| "none".to_string()),
            });
            if let Some(click_count) = input.click_count {
                params["clickCount"] = json!(click_count);
            }
            let result = client
                .send_command("Input.dispatchMouseEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Wheel { input, reply } => {
            let result = client
                .send_command(
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseWheel",
                        "x": input.x,
                        "y": input.y,
                        "deltaX": input.delta_x,
                        "deltaY": input.delta_y,
                    }),
                )
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Key { input, reply } => {
            let mut params = json!({
                "type": input.event_type,
                "key": input.key,
                "code": input.code.unwrap_or_default(),
                "modifiers": input.modifiers.unwrap_or(0),
            });
            if let Some(text) = input.text {
                params["text"] = json!(text);
            }
            if let Some(key_code) = input.windows_virtual_key_code {
                params["windowsVirtualKeyCode"] = json!(key_code);
            }
            let result = client
                .send_command("Input.dispatchKeyEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Text { text, reply } => {
            let result = client
                .send_command("Input.insertText", json!({ "text": text }))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
    }
    Ok(())
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
struct WebClosedEvent {
    session_id: String,
    error: Option<String>,
}

fn emit_frame(app: &AppHandle, session_id: &str, event: &Value) -> Result<(), String> {
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

fn emit_error(app: &AppHandle, session_id: &str, error: &str) {
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

fn normalize_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("web URL must not be empty".to_string());
    }
    if url.len() > 8 * 1024 {
        return Err("web URL is too long".to_string());
    }
    Ok(url.to_string())
}

fn validate_mouse(input: &WebMouseInput) -> Result<(), String> {
    if !matches!(
        input.event_type.as_str(),
        "mouseMoved" | "mousePressed" | "mouseReleased"
    ) {
        return Err("unsupported web mouse event".to_string());
    }
    validate_coordinate(input.x)?;
    validate_coordinate(input.y)?;
    if let Some(button) = input.button.as_deref() {
        if !matches!(
            button,
            "none" | "left" | "middle" | "right" | "back" | "forward"
        ) {
            return Err("unsupported web mouse button".to_string());
        }
    }
    Ok(())
}

fn validate_wheel(input: &WebWheelInput) -> Result<(), String> {
    validate_coordinate(input.x)?;
    validate_coordinate(input.y)?;
    if !input.delta_x.is_finite() || !input.delta_y.is_finite() {
        return Err("web wheel deltas must be finite".to_string());
    }
    Ok(())
}

fn validate_key(input: &WebKeyInput) -> Result<(), String> {
    if !matches!(input.event_type.as_str(), "keyDown" | "keyUp") {
        return Err("unsupported web key event".to_string());
    }
    if input.key.is_empty() || input.key.len() > 256 {
        return Err("web key must be present and short".to_string());
    }
    if let Some(text) = input.text.as_deref() {
        validate_text(text)?;
    }
    Ok(())
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_COMMAND_TEXT {
        return Err("web input text is too long".to_string());
    }
    Ok(())
}

fn validate_coordinate(value: f64) -> Result<(), String> {
    if !value.is_finite() || value.abs() > MAX_COORDINATE {
        return Err("web input coordinate is outside the supported range".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_url_normalization_keeps_about_blank_and_rejects_empty() {
        assert_eq!(normalize_url(" about:blank ").unwrap(), "about:blank");
        assert!(normalize_url(" ").is_err());
    }

    #[test]
    fn input_validation_accepts_supported_events_and_rejects_bad_coordinates() {
        assert!(validate_mouse(&WebMouseInput {
            event_type: "mousePressed".into(),
            x: 20.0,
            y: 40.0,
            button: Some("left".into()),
            click_count: Some(1),
        })
        .is_ok());
        assert!(validate_mouse(&WebMouseInput {
            event_type: "mouseMoved".into(),
            x: f64::NAN,
            y: 0.0,
            button: None,
            click_count: None,
        })
        .is_err());
    }

    #[test]
    fn key_validation_preserves_text_support() {
        assert!(validate_key(&WebKeyInput {
            event_type: "keyDown".into(),
            key: "a".into(),
            code: Some("KeyA".into()),
            text: Some("a".into()),
            modifiers: Some(0),
            windows_virtual_key_code: Some(65),
        })
        .is_ok());
        assert!(validate_key(&WebKeyInput {
            event_type: "keyPress".into(),
            key: "a".into(),
            code: None,
            text: None,
            modifiers: None,
            windows_virtual_key_code: None,
        })
        .is_err());
    }
}
