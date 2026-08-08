//! Scratch packaged-app smoke probe for the Huddle companion window.
//! Gate: BUZZ_HUDDLE_SMOKE=1. NEVER MERGE — this module exists only on the
//! huddle-window-smoke scratch branch.
//!
//! Scope: packaged boot + companion-window lifecycle through the REAL
//! commands (open_huddle_window / close_huddle_companion), including the
//! huddle- CloseRequested arm in lib.rs. Theme/CSP are out of scope here —
//! proven separately by the CSP smoke and untouched by PR 2.

use std::thread::sleep;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::huddle::state::HuddlePhase;
use crate::huddle::{close_huddle_companion, open_huddle_window};

const EPHEMERAL: &str = "smoke-ephemeral";
const LABEL: &str = "huddle-smoke-ephemeral";

fn finish(code: i32, facts: &[String], message: &str) -> ! {
    eprintln!("HUDDLE-SMOKE: {message}");
    for fact in facts {
        eprintln!("HUDDLE-SMOKE: fact {fact}");
    }
    std::process::exit(code);
}

pub fn run(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut facts: Vec<String> = Vec::new();

        // ── 1. Packaged app boots with the main window ──
        let main_window = match app.get_webview_window("main") {
            Some(window) => window,
            None => finish(1, &facts, "FAIL main window missing"),
        };
        facts.push("mainWindow=present".into());
        // Give the webview a beat to boot; a crash here kills the process
        // before PASS, which the runner treats as failure.
        sleep(Duration::from_secs(5));
        if !app.get_webview_window("main").is_some() {
            finish(1, &facts, "FAIL main window vanished during boot");
        }
        facts.push("mainAliveAfterBoot=true".into());
        let _ = &main_window;

        // ── 2. Seed the huddle state, then open via the REAL command ──
        {
            let state = app.state::<AppState>();
            let mut huddle = match state.huddle() {
                Ok(huddle) => huddle,
                Err(error) => finish(1, &facts, &format!("FAIL huddle state: {error}")),
            };
            huddle.ephemeral_channel_id = Some(EPHEMERAL.to_string());
            huddle.phase = HuddlePhase::Active;
        }
        let state = app.state::<AppState>();
        if let Err(error) = open_huddle_window(app.clone(), state).await {
            finish(1, &facts, &format!("FAIL open_huddle_window: {error}"));
        }
        facts.push("openOk=true".into());
        let companion = match app.get_webview_window(LABEL) {
            Some(window) => window,
            None => finish(1, &facts, "FAIL companion window not created"),
        };
        let title = companion.title().unwrap_or_else(|_| "ERR".into());
        facts.push(format!("companionTitle={title}"));
        if let Ok(size) = companion.inner_size() {
            facts.push(format!("companionSize={}x{}", size.width, size.height));
        }
        match companion.is_visible() {
            Ok(true) => facts.push("companionVisible=true".into()),
            Ok(false) => finish(1, &facts, "FAIL companion window not visible"),
            Err(error) => finish(1, &facts, &format!("FAIL companion is_visible: {error}")),
        }
        // Let the companion webview boot; any crash takes the process down.
        sleep(Duration::from_secs(8));
        if !app.get_webview_window(LABEL).is_some() {
            finish(1, &facts, "FAIL companion window vanished while loading");
        }
        facts.push("companionAliveAfterLoad=true".into());

        // ── 3. Close via the REAL command; exercises the CloseRequested arm ──
        let state = app.state::<AppState>();
        if let Err(error) = close_huddle_companion(app.clone(), state) {
            finish(1, &facts, &format!("FAIL close_huddle_companion: {error}"));
        }
        facts.push("closeOk=true".into());
        sleep(Duration::from_secs(1));
        if app.get_webview_window(LABEL).is_some() {
            finish(1, &facts, "FAIL companion window still present after close");
        }
        facts.push("companionGone=true".into());
        if !app.get_webview_window("main").is_some() {
            finish(1, &facts, "FAIL main window lost after companion close");
        }
        facts.push("mainSurvivedCompanionClose=true".into());

        finish(0, &facts, "PASS");
    });
}
