//! Runtime-owned CDP sessions backing channel workspace web tabs.
//!
//! The browser engine remains `buzz-browser`: this module only owns the Tauri
//! lifecycle and forwards the page's CDP screencast/input traffic to the
//! frontend. A session owns its websocket task until an explicit tab close,
//! community reset, app shutdown, or connection failure ends it; the browser
//! process itself is shared and refcounted (see `shared_host`).

mod commands;
mod events;
mod shared_host;
mod validation;

use self::commands::{execute_command, WebCommand};
pub use self::commands::{WebKeyInput, WebMouseInput, WebWheelInput};
use self::events::{
    emit_error, emit_frame, emit_startup_timings, SessionStartupTimings, WebClosedEvent,
};
use self::shared_host::SharedHostSlot;
use self::validation::{
    normalize_url, validate_device_scale_factor, validate_key, validate_mouse, validate_text,
    validate_viewport, validate_wheel,
};
use buzz_browser_pkg::{
    cdp::CdpClient,
    mcp::{open_host, pick_target, ConnectParams},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Runtime};
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

struct WebSession {
    commands: mpsc::Sender<WebCommand>,
    stop_requested: Arc<AtomicBool>,
    done: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Set when this session's host came from the shared-launch path
    /// (`shared_host::acquire_host`). Every session attaches rather than
    /// owning its browser process directly; releasing this claim on drop
    /// keeps the shared browser alive exactly as long as any session still
    /// needs it, and kills it once the last one is gone.
    shared_host: Option<SharedHostSlot>,
}

impl Drop for WebSession {
    fn drop(&mut self) {
        if let Some(shared_host) = &self.shared_host {
            shared_host::release(shared_host);
        }
    }
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

type WebShutdownWork = (Vec<Arc<WebSession>>, Vec<std::sync::mpsc::Receiver<()>>);

/// The native owner for all live workspace web tabs.
#[derive(Default)]
pub struct WebManager {
    sessions: Mutex<HashMap<String, Arc<WebSession>>>,
    starts: Mutex<StartState>,
    /// One Chromium shared across every launch-path session (no explicit
    /// `endpoint`). See `shared_host` for the refcounting.
    shared_host: SharedHostSlot,
}

impl WebManager {
    /// Attach to or launch a browser through the shared `buzz-browser` path.
    pub async fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
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

    async fn start_inner<R: Runtime>(
        &self,
        app: AppHandle<R>,
        request: WebStartRequest,
        url: String,
        token: StartToken,
    ) -> Result<WebStartResult, String> {
        let start = Instant::now();
        let endpoint = request
            .endpoint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);

        // Two ways to get a ready host: attach to a caller-supplied DevTools
        // endpoint (unchanged), or - the common case, no endpoint - reuse the
        // one Chromium this process already launched for earlier tabs.
        // Measured cold launch is ~7s versus ~250ms to attach to a running
        // host, so relaunching per tab was the dominant cost in first paint.
        let (host, shared_reservation) = if let Some(endpoint) = endpoint.clone() {
            let params = ConnectParams {
                // Launch configuration stays in buzz-browser's trusted
                // discovery path. The relay-synchronized tab payload never
                // chooses a local executable and every owned launch is
                // headless.
                binary: None,
                headless: Some(true),
                endpoint: Some(endpoint),
                target_id: request.target_id.clone(),
            };
            let host = tokio::time::timeout(START_TIMEOUT, open_host(&params))
                .await
                .map_err(|_| "browser connection timed out".to_string())?
                .map_err(|error| error.to_string())?;
            (host, None)
        } else {
            let (host, reservation) =
                tokio::time::timeout(START_TIMEOUT, shared_host::acquire_host(&self.shared_host))
                    .await
                    .map_err(|_| "browser connection timed out".to_string())?
                    .map_err(|error| error.to_string())?;
            (host, Some(reservation))
        };
        let host_ready = Instant::now();
        let owns_browser_process = host.owns_browser_process();
        let browser_pid = host.process_id();
        let target = if endpoint.is_some() {
            let targets = tokio::time::timeout(START_TIMEOUT, host.list_targets())
                .await
                .map_err(|_| "browser target listing timed out".to_string())?
                .map_err(|error| error.to_string())?;
            pick_target(&targets, request.target_id.as_deref())
                .map_err(|error| error.to_string())?
                .clone()
        } else {
            tokio::time::timeout(START_TIMEOUT, host.new_target())
                .await
                .map_err(|_| "browser target listing timed out".to_string())?
                .map_err(|error| error.to_string())?
        };
        let mut client = tokio::time::timeout(START_TIMEOUT, CdpClient::connect(&target.ws_url))
            .await
            .map_err(|_| "CDP connection timed out".to_string())?
            .map_err(|error| error.to_string())?;
        let cdp_connected = Instant::now();

        initialize_page(&mut client, &url)
            .await
            .map_err(|error| error.to_string())?;
        let page_initialized = Instant::now();
        let startup_timings = SessionStartupTimings {
            start,
            host_ready,
            cdp_connected,
            page_initialized,
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let (commands, receiver) = mpsc::channel(64);
        let (done_sender, done_receiver) = std::sync::mpsc::channel();
        let session = Arc::new(WebSession {
            commands,
            stop_requested: Arc::clone(&stop_requested),
            done: Mutex::new(Some(done_receiver)),
            task: Mutex::new(None),
            shared_host: shared_reservation.map(shared_host::SharedHostReservation::keep),
        });

        if !self.insert_if_current(token, session_id.clone(), Arc::clone(&session))? {
            return Err("web start was cancelled".to_string());
        }

        let task = tokio::spawn(run_session(
            app,
            session_id.clone(),
            SessionRuntime {
                host,
                client,
                startup_timings,
            },
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

    pub async fn resize(
        &self,
        session_id: &str,
        width: u32,
        height: u32,
        device_scale_factor: f64,
    ) -> Result<(), String> {
        validate_viewport(width, height)?;
        validate_device_scale_factor(device_scale_factor)?;
        self.dispatch(session_id, |reply| WebCommand::Resize {
            width,
            height,
            device_scale_factor,
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

    fn invalidate_and_drain(&self) -> Result<WebShutdownWork, String> {
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

    /// Test-only: the shared browser's PID, if a launch-path session has one
    /// running. See `shared_host::pid`.
    #[cfg(test)]
    pub(super) fn shared_host_pid(&self) -> Option<u32> {
        shared_host::pid(&self.shared_host)
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
            // Static cap sized for a 2x-scaled 1600x1200 CSS viewport (the
            // largest we clamp devicePixelRatio to) so a retina resize is
            // never re-shrunk by the screencast itself.
            "quality": 92,
            "maxWidth": 3200,
            "maxHeight": 2400,
            "everyNthFrame": 1
        }),
    )
    .await?;
    if url != "about:blank" {
        send_command_bounded(client, "Page.navigate", json!({ "url": url })).await?;
    }
    Ok(())
}

/// The browser-side pieces a running session owns: the host process handle,
/// its CDP connection, and the startup timings reported on the first frame.
/// Grouped so `run_session` stays inside the argument-count lint.
struct SessionRuntime {
    host: buzz_browser_pkg::host::BrowserHost,
    client: CdpClient,
    startup_timings: SessionStartupTimings,
}

async fn run_session<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    runtime: SessionRuntime,
    stop_requested: Arc<AtomicBool>,
    mut commands: mpsc::Receiver<WebCommand>,
    done_sender: std::sync::mpsc::Sender<()>,
) {
    let SessionRuntime {
        host,
        mut client,
        startup_timings,
    } = runtime;
    #[cfg(test)]
    if let Some(pause) = web_lifecycle_tests::take_session_pause() {
        let _ = pause.entered.send(());
        let _ = pause.release.recv();
    }
    let result = run_session_loop(
        &app,
        &session_id,
        &mut client,
        &stop_requested,
        &mut commands,
        &startup_timings,
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
    drop(host);
    let _ = done_sender.send(());
}

async fn run_session_loop<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    client: &mut CdpClient,
    stop_requested: &AtomicBool,
    commands: &mut mpsc::Receiver<WebCommand>,
    startup_timings: &SessionStartupTimings,
) -> Result<(), String> {
    let mut first_frame_logged = false;
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
                    if !first_frame_logged {
                        first_frame_logged = true;
                        emit_startup_timings(session_id, startup_timings);
                    }
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
            result?;
        }
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
    fn viewport_validation_rejects_tiny_and_unbounded_surfaces() {
        assert!(validate_viewport(1280, 720).is_ok());
        assert!(validate_viewport(120, 720).is_err());
        assert!(validate_viewport(1280, 8_000).is_err());
    }

    #[test]
    fn device_scale_factor_validation_rejects_out_of_range_and_non_finite() {
        assert!(validate_device_scale_factor(1.0).is_ok());
        assert!(validate_device_scale_factor(2.0).is_ok());
        assert!(validate_device_scale_factor(1.5).is_ok());
        assert!(validate_device_scale_factor(0.5).is_err());
        assert!(validate_device_scale_factor(2.5).is_err());
        assert!(validate_device_scale_factor(f64::NAN).is_err());
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
            shared_host: None,
        })
    }
}

#[cfg(test)]
#[path = "web_lifecycle_tests.rs"]
mod web_lifecycle_tests;
