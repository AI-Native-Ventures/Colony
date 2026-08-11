//! Owned-browser lifecycle for `WebManager`, against a real headless Chromium.
//!
//! These tests replace the three visible browser sessions the packaged WDIO
//! journey used to open. A generic Tauri runtime lets
//! `tauri::test::mock_app` drive the complete `WebManager::start` path with no
//! window, so a full session can be started and torn down in seconds without
//! a packaged build.
//!
//! Gated on `BUZZ_BROWSER_REAL=1` because they launch an actual browser.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};

use super::{WebManager, WebStartRequest, WebStartResult};

pub(super) struct SessionPause {
    pub(super) entered: std::sync::mpsc::Sender<()>,
    pub(super) release: std::sync::mpsc::Receiver<()>,
}

static SESSION_PAUSE: std::sync::OnceLock<std::sync::Mutex<Option<SessionPause>>> =
    std::sync::OnceLock::new();

pub(super) fn take_session_pause() -> Option<SessionPause> {
    SESSION_PAUSE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .ok()
        .and_then(|mut pause| pause.take())
}

fn install_session_pause(
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
) {
    *SESSION_PAUSE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = Some(SessionPause { entered, release });
}

/// `ps -p` rather than a raw signal probe: this crate forbids `unsafe`, and a
/// reaped-but-unwaited zombie must still read as gone.
fn process_is_alive(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .map(|out| {
            let stat = String::from_utf8_lossy(&out.stdout);
            let stat = stat.trim();
            !stat.is_empty() && !stat.starts_with('Z')
        })
        .unwrap_or(false)
}

async fn wait_for_pid_gone(pid: u32, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if !process_is_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

fn owned_request() -> WebStartRequest {
    WebStartRequest {
        // No endpoint means Colony launches and owns the browser.
        endpoint: None,
        target_id: None,
        url: "about:blank".to_string(),
    }
}

async fn start_owned<R: Runtime>(
    manager: &WebManager,
    app: AppHandle<R>,
) -> Result<WebStartResult, String> {
    // All launches in one test share this temp root. The product's host layer
    // must still assign each owned launch a distinct profile below it.
    let previous_tmpdir = set_shared_tmpdir();
    let result = manager.start(app, owned_request()).await;
    restore_tmpdir(previous_tmpdir);
    result
}

async fn start_two_owned<R: Runtime>(
    manager: &WebManager,
    first_app: AppHandle<R>,
    second_app: AppHandle<R>,
) -> (
    Result<WebStartResult, String>,
    Result<WebStartResult, String>,
) {
    let previous_tmpdir = set_shared_tmpdir();
    let results = tokio::join!(
        manager.start(first_app, owned_request()),
        manager.start(second_app, owned_request()),
    );
    restore_tmpdir(previous_tmpdir);
    results
}

fn set_shared_tmpdir() -> Option<std::ffi::OsString> {
    let profile_root = profile_root();
    std::fs::create_dir_all(&profile_root).expect("failed to create browser profile root");
    let previous_tmpdir = std::env::var_os("TMPDIR");
    std::env::set_var("TMPDIR", profile_root);
    previous_tmpdir
}

fn restore_tmpdir(previous_tmpdir: Option<std::ffi::OsString>) {
    if let Some(tmpdir) = previous_tmpdir {
        std::env::set_var("TMPDIR", tmpdir);
    } else {
        std::env::remove_var("TMPDIR");
    }
}

fn cleanup_profile_root() {
    let profile_root =
        std::env::temp_dir().join(format!("buzz-web-lifecycle-shared-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(profile_root);
}

fn profile_root() -> PathBuf {
    std::env::temp_dir().join(format!("buzz-web-lifecycle-shared-{}", std::process::id()))
}

fn owned_profile_dirs() -> Vec<PathBuf> {
    std::fs::read_dir(profile_root())
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("buzz-browser-profile-"))
        })
        .collect()
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn closing_a_session_reaps_the_browser_it_owns() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = Arc::new(WebManager::default());

    let started = start_owned(&manager, app.handle().clone())
        .await
        .expect("owned web session failed to start");
    assert!(started.owns_browser_process);
    let pid = started
        .browser_pid
        .expect("an owned session must expose a browser PID");
    assert!(process_is_alive(pid), "browser {pid} was not running");

    manager
        .close(&started.session_id)
        .await
        .expect("closing the session failed");

    assert!(
        wait_for_pid_gone(pid, Duration::from_secs(30)).await,
        "browser {pid} survived session close"
    );
    cleanup_profile_root();
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn close_all_reaps_every_owned_browser() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = Arc::new(WebManager::default());

    let (first, second) =
        start_two_owned(&manager, app.handle().clone(), app.handle().clone()).await;
    let first = first.expect("first owned web session failed to start");
    let second = second.expect("second owned web session failed to start");
    let pids: Vec<u32> = [first.browser_pid, second.browser_pid]
        .into_iter()
        .map(|pid| pid.expect("an owned session must expose a browser PID"))
        .collect();
    for pid in &pids {
        assert!(process_is_alive(*pid), "browser {pid} was not running");
    }

    // This is the community-reset path: it calls close_all_async.
    manager
        .close_all_async()
        .await
        .expect("close_all_async failed");

    for pid in pids {
        assert!(
            wait_for_pid_gone(pid, Duration::from_secs(30)).await,
            "browser {pid} survived close_all"
        );
    }
    cleanup_profile_root();
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn synchronous_close_all_reaps_every_owned_browser() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = Arc::new(WebManager::default());

    let started = start_owned(&manager, app.handle().clone())
        .await
        .expect("owned web session failed to start");
    let pid = started
        .browser_pid
        .expect("an owned session must expose a browser PID");
    assert!(process_is_alive(pid), "browser {pid} was not running");

    // App shutdown calls the synchronous path from its signal and exit hooks.
    let close_manager = Arc::clone(&manager);
    tokio::task::spawn_blocking(move || close_manager.close_all())
        .await
        .expect("synchronous close_all task panicked");

    assert!(
        !process_is_alive(pid),
        "browser {pid} survived synchronous close_all"
    );
    cleanup_profile_root();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn synchronous_close_all_timeout_reaps_owned_browser_before_return() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = Arc::new(WebManager::default());
    let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
    let (release_sender, release_receiver) = std::sync::mpsc::channel();
    install_session_pause(entered_sender, release_receiver);

    let started = start_owned(&manager, app.handle().clone())
        .await
        .expect("owned web session failed to start");
    let pid = started
        .browser_pid
        .expect("an owned session must expose a browser PID");
    assert!(process_is_alive(pid), "browser {pid} was not running");
    tokio::task::spawn_blocking(move || {
        entered_receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("session did not reach the fault-injected stall");
    })
    .await
    .expect("session pause waiter panicked");
    let profile_dir = owned_profile_dirs()
        .into_iter()
        .next()
        .expect("owned session did not create a profile directory");

    let (closed_sender, closed_receiver) = std::sync::mpsc::channel();
    let close_manager = Arc::clone(&manager);
    std::thread::spawn(move || {
        close_manager.close_all();
        let _ = closed_sender.send(());
    });
    tokio::task::spawn_blocking(move || {
        closed_receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("close_all did not return from its timeout branch");
    })
    .await
    .expect("close_all waiter panicked");

    assert!(
        !process_is_alive(pid),
        "browser {pid} survived timeout close_all"
    );
    assert!(
        !profile_dir.exists(),
        "owned browser profile survived timeout close_all: {}",
        profile_dir.display()
    );
    let _ = release_sender.send(());
    cleanup_profile_root();
}
