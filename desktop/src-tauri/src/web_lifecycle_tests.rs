//! Owned-browser lifecycle for `WebManager`, against a real headless Chromium.
//!
//! These tests replace the three visible browser sessions the packaged WDIO
//! journey used to open. The current `WebManager::start` signature requires a
//! Wry runtime, while `tauri::test::mock_app` supplies a mock runtime, so the
//! tests use the real `open_host` path plus explicit manager bookkeeping and
//! tear down in seconds without a packaged build.
//!
//! Gated on `BUZZ_BROWSER_REAL=1` because they launch an actual browser.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use buzz_browser_pkg::mcp::{open_host, ConnectParams};

use super::{WebManager, WebSession};

static PROFILE_COUNTER: AtomicU64 = AtomicU64::new(1);

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

async fn insert_owned_session(manager: &WebManager, session_id: &str) -> u32 {
    // `open_host` uses a fixed profile under `temp_dir`; give each real launch
    // an isolated temp root so two owned sessions can coexist in close_all.
    let profile_root = std::env::temp_dir().join(format!(
        "buzz-web-lifecycle-{}-{}",
        std::process::id(),
        PROFILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&profile_root).expect("failed to create browser profile root");
    let previous_tmpdir = std::env::var_os("TMPDIR");
    std::env::set_var("TMPDIR", &profile_root);
    let host_result = open_host(&ConnectParams {
        // No endpoint means Colony launches and owns the browser.
        binary: None,
        headless: Some(true),
        endpoint: None,
        target_id: None,
    })
    .await;
    if let Some(tmpdir) = previous_tmpdir {
        std::env::set_var("TMPDIR", tmpdir);
    } else {
        std::env::remove_var("TMPDIR");
    }
    let host = host_result.expect("owned browser failed to start");
    let pid = host
        .process_id()
        .expect("an owned host must expose a browser PID");
    let stop_requested = Arc::new(AtomicBool::new(false));
    let (commands, _receiver) = tokio::sync::mpsc::channel(1);
    let (done_sender, done_receiver) = std::sync::mpsc::channel();
    let task_stop_requested = Arc::clone(&stop_requested);
    let task = tokio::spawn(async move {
        while !task_stop_requested.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(host);
        let _ = done_sender.send(());
    });
    let session = Arc::new(WebSession {
        commands,
        stop_requested,
        done: Mutex::new(Some(done_receiver)),
        task: Mutex::new(Some(task)),
    });
    manager
        .sessions
        .lock()
        .expect("web session store was poisoned")
        .insert(session_id.to_string(), session);
    pid
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn closing_a_session_reaps_the_browser_it_owns() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let manager = WebManager::default();
    // `WebManager::start` currently requires AppHandle<Wry>, while
    // `tauri::test::mock_app` returns AppHandle<MockRuntime>. Exercise the
    // same ownership and teardown path by inserting a real open_host session
    // into the manager's bookkeeping without the packaged app.
    let session_id = "lifecycle-close";
    let pid = insert_owned_session(&manager, session_id).await;
    assert!(process_is_alive(pid), "browser {pid} was not running");

    manager
        .close(session_id)
        .await
        .expect("closing the session failed");

    assert!(
        wait_for_pid_gone(pid, Duration::from_secs(30)).await,
        "browser {pid} survived session close"
    );
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn close_all_reaps_every_owned_browser() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let manager = WebManager::default();

    let pids = vec![
        insert_owned_session(&manager, "lifecycle-close-all-first").await,
        insert_owned_session(&manager, "lifecycle-close-all-second").await,
    ];
    for pid in &pids {
        assert!(process_is_alive(*pid), "browser {pid} was not running");
    }

    // This is the community-reset and app-quit path: both call close_all.
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
}
