//! Runtime-owned CDP sessions backing channel workspace web tabs.
//!
//! The browser engine remains `buzz-browser`: this module only owns the Tauri
//! lifecycle and forwards the page's CDP screencast/input traffic to the
//! frontend. A session owns its host and websocket task until an explicit tab
//! close, community reset, app shutdown, or connection failure ends it.

mod validation;

use self::validation::{
    normalize_url, validate_key, validate_mouse, validate_text, validate_viewport, validate_wheel,
};
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

const SESSION_POLL: Duration = Duration::from_millis(100);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const START_WAIT_TIMEOUT: Duration = Duration::from_secs(25);
const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct WebStartRequest {
    /// Existing DevTools endpoint; `None` launches through `buzz-browser`.
    pub endpoint: Option<String>,
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
    /// Runtime-only process id for an owned launch; attached hosts return `None`.
    pub browser_pid: Option<u32>,
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
    Back {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Forward {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Reload {
        reply: oneshot::Sender<Result<(), String>>,
    },
    Resize {
        width: u32,
        height: u32,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

struct WebSession {
    commands: mpsc::Sender<WebCommand>,
    stop_requested: Arc<AtomicBool>,
    done: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

struct PendingStart {
    done_receiver: std::sync::mpsc::Receiver<()>,
    cancel_sender: oneshot::Sender<()>,
}

#[derive(Clone, Copy)]
struct StartToken {
    id: u64,
    generation: u64,
}

struct StartState {
    generation: u64,
    next_id: u64,
    pending: HashMap<u64, PendingStart>,
}

impl Default for StartState {
    fn default() -> Self {
        Self {
            generation: 0,
            next_id: 1,
            pending: HashMap::new(),
        }
    }
}

/// The native owner for all live workspace web tabs.
#[derive(Default)]
pub struct WebManager {
    sessions: Mutex<HashMap<String, Arc<WebSession>>>,
    starts: Mutex<StartState>,
}

impl WebManager {
    /// Attach to or launch a browser through the shared `buzz-browser` path.
    pub async fn start(
        &self,
        app: AppHandle,
        request: WebStartRequest,
    ) -> Result<WebStartResult, String> {
        let url = normalize_url(&request.url)?;
        let (token, done_sender, mut cancel_receiver) = self.begin_start()?;
        let result = tokio::select! {
            biased;
            // `start_inner` inserts and spawns the session in the same poll as
            // its final Ready result. Prefer that completed result when a
            // cancellation notification arrives at the same instant; the
            // generation fence still rejects cancellation before insertion.
            result = self.start_inner(app, request, url, token) => result,
            _ = &mut cancel_receiver => Err("web start was cancelled".to_string()),
        };
        self.finish_start(token, done_sender);
        result
    }

    async fn start_inner(
        &self,
        app: AppHandle,
        request: WebStartRequest,
        url: String,
        token: StartToken,
    ) -> Result<WebStartResult, String> {
        let params = ConnectParams {
            // Launch configuration stays in buzz-browser's trusted discovery
            // path. The relay-synchronized tab payload never chooses a local
            // executable and every owned launch is headless.
            binary: None,
            headless: Some(true),
            endpoint: request
                .endpoint
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            target_id: request.target_id,
        };
        let host = tokio::time::timeout(START_TIMEOUT, open_host(&params))
            .await
            .map_err(|_| "browser connection timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let owns_browser_process = host.owns_browser_process();
        let browser_pid = host.process_id();
        let targets = tokio::time::timeout(START_TIMEOUT, host.list_targets())
            .await
            .map_err(|_| "browser target listing timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let target = pick_target(&targets, params.target_id.as_deref())
            .map_err(|error| error.to_string())?
            .clone();
        let mut client = tokio::time::timeout(START_TIMEOUT, CdpClient::connect(&target.ws_url))
            .await
            .map_err(|_| "CDP connection timed out".to_string())?
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
            task: Mutex::new(None),
        });

        if !self.insert_if_current(token, session_id.clone(), Arc::clone(&session))? {
            return Err("web start was cancelled".to_string());
        }

        let task = tokio::spawn(run_session(
            app,
            session_id.clone(),
            host,
            client,
            stop_requested,
            receiver,
            done_sender,
        ));
        let mut task_slot = match session.task.lock() {
            Ok(task_slot) => task_slot,
            Err(error) => {
                task.abort();
                let _ = self.remove(&session_id);
                return Err(format!("web session task store is poisoned: {error}"));
            }
        };
        *task_slot = Some(task);

        Ok(WebStartResult {
            session_id,
            target_id: target.id,
            url,
            owns_browser_process,
            browser_pid,
        })
    }

    /// Navigate the page driven by a web tab.
    pub async fn navigate(&self, session_id: &str, url: String) -> Result<(), String> {
        let url = normalize_url(&url)?;
        self.dispatch(session_id, |reply| WebCommand::Navigate { url, reply })
            .await
    }

    pub async fn back(&self, session_id: &str) -> Result<(), String> {
        self.dispatch(session_id, |reply| WebCommand::Back { reply })
            .await
    }

    pub async fn forward(&self, session_id: &str) -> Result<(), String> {
        self.dispatch(session_id, |reply| WebCommand::Forward { reply })
            .await
    }

    pub async fn reload(&self, session_id: &str) -> Result<(), String> {
        self.dispatch(session_id, |reply| WebCommand::Reload { reply })
            .await
    }

    pub async fn resize(&self, session_id: &str, width: u32, height: u32) -> Result<(), String> {
        validate_viewport(width, height)?;
        self.dispatch(session_id, |reply| WebCommand::Resize {
            width,
            height,
            reply,
        })
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
        let (sessions, pending_starts) = self.invalidate_and_drain()?;
        let mut failure: Option<String> = None;
        for session in sessions {
            if let Err(error) = stop_and_wait(session).await {
                failure.get_or_insert(error);
            }
        }
        for receiver in pending_starts {
            if let Err(error) = wait_for_start(receiver).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Close every web tab synchronously during app shutdown.
    pub fn close_all(&self) {
        let (sessions, pending_starts) = match self.invalidate_and_drain() {
            Ok(result) => result,
            Err(error) => {
                eprintln!("buzz-desktop: failed to drain web sessions: {error}");
                (Vec::new(), Vec::new())
            }
        };
        for session in sessions {
            session.stop_requested.store(true, Ordering::SeqCst);
            if !wait_for_done(&session) {
                eprintln!("buzz-desktop: timed out stopping web session task");
                abort_session_task_now(&session);
            } else {
                drop_session_task(&session);
            }
        }
        for receiver in pending_starts {
            if receiver.recv_timeout(START_WAIT_TIMEOUT).is_err() {
                eprintln!("buzz-desktop: timed out cancelling web start");
            }
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

    fn begin_start(
        &self,
    ) -> Result<
        (
            StartToken,
            std::sync::mpsc::Sender<()>,
            oneshot::Receiver<()>,
        ),
        String,
    > {
        let mut state = self
            .starts
            .lock()
            .map_err(|error| format!("web start store is poisoned: {error}"))?;
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let (cancel_sender, cancel_receiver) = oneshot::channel();
        let token = StartToken {
            id,
            generation: state.generation,
        };
        state.pending.insert(
            id,
            PendingStart {
                done_receiver,
                cancel_sender,
            },
        );
        Ok((token, done_sender, cancel_receiver))
    }

    fn finish_start(&self, token: StartToken, done_sender: std::sync::mpsc::Sender<()>) {
        if let Ok(mut state) = self.starts.lock() {
            state.pending.remove(&token.id);
        }
        let _ = done_sender.send(());
    }

    fn insert_if_current(
        &self,
        token: StartToken,
        session_id: String,
        session: Arc<WebSession>,
    ) -> Result<bool, String> {
        // Hold the generation guard while taking the session lock. Reset/close
        // takes the same order, so a late attach cannot slip between the check
        // and insertion after close_all has invalidated this generation.
        let state = self
            .starts
            .lock()
            .map_err(|error| format!("web start store is poisoned: {error}"))?;
        if state.generation != token.generation {
            return Ok(false);
        }
        self.sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))?
            .insert(session_id, session);
        Ok(true)
    }

    fn invalidate_and_drain(
        &self,
    ) -> Result<(Vec<Arc<WebSession>>, Vec<std::sync::mpsc::Receiver<()>>), String> {
        let mut state = self
            .starts
            .lock()
            .map_err(|error| format!("web start store is poisoned: {error}"))?;
        state.generation = state.generation.wrapping_add(1);
        let pending_starts = state
            .pending
            .drain()
            .map(|(_, pending)| {
                let _ = pending.cancel_sender.send(());
                pending.done_receiver
            })
            .collect();
        let sessions = self
            .sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))?
            .drain()
            .map(|(_, session)| session)
            .collect();
        Ok((sessions, pending_starts))
    }

    fn remove(&self, session_id: &str) -> Result<Option<Arc<WebSession>>, String> {
        self.sessions
            .lock()
            .map_err(|error| format!("web session store is poisoned: {error}"))
            .map(|mut sessions| sessions.remove(session_id))
    }
}

async fn stop_and_wait(session: Arc<WebSession>) -> Result<(), String> {
    session.stop_requested.store(true, Ordering::SeqCst);
    let wait_session = Arc::clone(&session);
    let stopped = tokio::task::spawn_blocking(move || wait_for_done(&wait_session))
        .await
        .map_err(|error| format!("web session shutdown task failed: {error}"))?;
    if stopped {
        reap_session_task(&session).await;
        Ok(())
    } else {
        abort_session_task(&session).await;
        Err("timed out stopping web session task".to_string())
    }
}

fn wait_for_done(session: &WebSession) -> bool {
    let receiver = session.done.lock().ok().and_then(|mut done| done.take());
    receiver
        .map(|receiver| receiver.recv_timeout(CLOSE_TIMEOUT).is_ok())
        .unwrap_or(true)
}

async fn reap_session_task(session: &WebSession) {
    let task = session.task.lock().ok().and_then(|mut task| task.take());
    if let Some(task) = task {
        let _ = task.await;
    }
}

async fn abort_session_task(session: &WebSession) {
    let task = session.task.lock().ok().and_then(|mut task| task.take());
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}

fn abort_session_task_now(session: &WebSession) {
    if let Some(task) = session.task.lock().ok().and_then(|mut task| task.take()) {
        task.abort();
    }
}

fn drop_session_task(session: &WebSession) {
    let _ = session.task.lock().ok().and_then(|mut task| task.take());
}

async fn wait_for_start(receiver: std::sync::mpsc::Receiver<()>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        receiver
            .recv_timeout(START_WAIT_TIMEOUT)
            .map_err(|_| "timed out cancelling web start".to_string())
    })
    .await
    .map_err(|error| format!("web start wait task failed: {error}"))?
}

async fn send_command_bounded(
    client: &mut CdpClient,
    method: &str,
    params: Value,
) -> Result<Value, buzz_browser_pkg::BrowserError> {
    tokio::time::timeout(CDP_COMMAND_TIMEOUT, client.send_command(method, params))
        .await
        .map_err(|_| {
            buzz_browser_pkg::BrowserError::Cdp(format!("CDP command timed out: {method}"))
        })?
}

async fn initialize_page(
    client: &mut CdpClient,
    url: &str,
) -> Result<(), buzz_browser_pkg::BrowserError> {
    send_command_bounded(client, "Page.enable", json!({})).await?;
    send_command_bounded(
        client,
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
        send_command_bounded(client, "Page.navigate", json!({ "url": url })).await?;
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
                send_command_bounded(client, "Page.stopScreencast", json!({})),
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
                    send_command_bounded(
                        client,
                        "Page.screencastFrameAck",
                        json!({ "sessionId": frame_id }),
                    )
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
            let result = send_command_bounded(client, "Page.navigate", json!({ "url": url }))
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
            let result = send_command_bounded(client, "Input.dispatchMouseEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Wheel { input, reply } => {
            let result = send_command_bounded(
                client,
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
            let result = send_command_bounded(client, "Input.dispatchKeyEvent", params)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Text { text, reply } => {
            let result = send_command_bounded(client, "Input.insertText", json!({ "text": text }))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Back { reply } => {
            let _ = reply.send(navigate_history(client, -1).await);
        }
        WebCommand::Forward { reply } => {
            let _ = reply.send(navigate_history(client, 1).await);
        }
        WebCommand::Reload { reply } => {
            let result =
                send_command_bounded(client, "Page.reload", json!({ "ignoreCache": false }))
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
        WebCommand::Resize {
            width,
            height,
            reply,
        } => {
            let result = send_command_bounded(
                client,
                "Emulation.setDeviceMetricsOverride",
                json!({ "width": width, "height": height, "deviceScaleFactor": 1, "mobile": false }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
            let _ = reply.send(result);
        }
    }
    Ok(())
}

async fn navigate_history(client: &mut CdpClient, delta: i64) -> Result<(), String> {
    let history = send_command_bounded(client, "Page.getNavigationHistory", json!({}))
        .await
        .map_err(|error| error.to_string())?;
    let index = history["currentIndex"].as_i64().unwrap_or(0) + delta;
    let entry_id = history["entries"]
        .as_array()
        .and_then(|entries| {
            usize::try_from(index)
                .ok()
                .and_then(|index| entries.get(index))
        })
        .and_then(|entry| entry["id"].as_i64());
    let Some(entry_id) = entry_id else {
        return Ok(());
    };
    send_command_bounded(
        client,
        "Page.navigateToHistoryEntry",
        json!({ "entryId": entry_id }),
    )
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
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

    #[test]
    fn viewport_validation_rejects_tiny_and_unbounded_surfaces() {
        assert!(validate_viewport(1280, 720).is_ok());
        assert!(validate_viewport(120, 720).is_err());
        assert!(validate_viewport(1280, 8_000).is_err());
    }

    #[tokio::test]
    async fn close_all_invalidates_a_deferred_start_before_late_insertion() {
        let manager = WebManager::default();
        let (token, done_sender, cancel_receiver) = manager.begin_start().unwrap();
        let cancelled = tokio::spawn(async move { cancel_receiver.await.is_ok() });

        let (drained_sessions, pending_starts) = manager.invalidate_and_drain().unwrap();
        assert!(drained_sessions.is_empty());
        assert_eq!(pending_starts.len(), 1);
        assert!(
            !manager
                .insert_if_current(token, "late-session".into(), test_session())
                .unwrap(),
            "a late host must not populate after close_all invalidates its generation"
        );
        assert!(manager.sessions.lock().unwrap().is_empty());
        assert!(cancelled.await.unwrap());

        manager.finish_start(token, done_sender);
        assert!(pending_starts[0]
            .recv_timeout(Duration::from_secs(1))
            .is_ok());
    }

    fn test_session() -> Arc<WebSession> {
        let (commands, _receiver) = mpsc::channel(1);
        let (_done_sender, done_receiver) = std::sync::mpsc::channel();
        Arc::new(WebSession {
            commands,
            stop_requested: Arc::new(AtomicBool::new(false)),
            done: Mutex::new(Some(done_receiver)),
            task: Mutex::new(None),
        })
    }
}

#[cfg(test)]
#[path = "web_lifecycle_tests.rs"]
mod web_lifecycle_tests;
