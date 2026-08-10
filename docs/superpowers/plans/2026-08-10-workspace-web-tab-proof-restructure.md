# Workspace Web Tab Proof Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every proof in the Web workspace tab to the cheapest layer that can hold it, so the packaged Tauri journey runs once instead of dozens of times, then finish the packaged proof and evidence still owed by the original plan.

**Architecture:** Process lifecycle (owned browser PID, reaping on close/reset/quit) moves to Rust integration tests against real headless Chromium, with no Tauri and no visible windows. Engine input behaviour lives in Playwright projects on both Chromium and WebKit, because WebKit is the engine behind the packaged macOS WKWebView. The packaged WDIO flow keeps only what nothing else can prove: real IPC through the signed bundle rendering a real CDP frame, plus one screenshot.

**Tech Stack:** Rust/Tokio, `buzz-browser`, `tauri::test::mock_app`, Chrome DevTools Protocol, React 19 + TypeScript, Playwright (Chromium + WebKit), WebdriverIO packaged-app harness.

## Global Constraints

- Predecessor plan: `docs/superpowers/plans/2026-08-10-workspace-web-tab-packaged-proof.md`. Predecessor design: `docs/superpowers/specs/2026-08-10-workspace-web-tab-packaged-proof-design.md`. This plan amends both; it does not replace them.
- No broad local `just ci`, no `pnpm check`, no workspace-wide clippy or test runs. Focused gates only.
- Branch is `feat/workspace-web-tab`. Never push to `main` or `develop`.
- Every commit uses `git commit -s`. Activate hermit first: `. ./bin/activate-hermit`.
- No `unsafe` code. No new `unwrap()`/`expect()` in production paths (test code may use them).
- Rust files stay under the 1000-line ceiling. `desktop/src-tauri/src/web.rs` is currently 976 lines, so new Rust tests for it go in a sibling file, not inline.
- `workspaceWebTab` stays `defaultEnabled: false` in `preview-features.json`.
- Reserved harness ports for any packaged run: `BUZZ_HARNESS_RELAY_PORT=3040 BUZZ_HARNESS_PG_PORT=5481 BUZZ_HARNESS_REDIS_PORT=6481 BUZZ_HARNESS_MINIO_PORT=9481 BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212`.
- Every new test must be run against unfixed code and observed to fail before the fix is written. A test that has never been red proves nothing.
- No em-dashes in any file this plan touches.

---

## Status of prior work

| Item | Origin | State |
|---|---|---|
| Reconciliation onto merged develop | Predecessor plan Task 1 | Done |
| Owned browser PID observability | Predecessor plan Task 2 | Done |
| Loopback web fixture | Predecessor plan Task 3 | Done |
| Packaged flow 08 | Predecessor plan Task 4 | Written; last recorded run `fail` |
| Focused frontend/native gates | Predecessor plan Task 5 steps 1-4 | Done |
| Packaged flow 08 green + artifacts + cleanup | Predecessor plan Task 5 steps 5-6 | **Owed** |
| Evidence doc, push, remote verification | Predecessor plan Task 6 | **Owed** |
| Browser chrome, URL bar, full-panel viewport sync | Unplanned, commits `44055c13f1` `31d209a304` `ff3ec194b3` | Landed, undocumented |
| Engine-parity Playwright projects + wheel fix | Unplanned, commit `b4458f2b66` | Landed, undocumented |

Task 1 below records the two unplanned changes against the design. Tasks 2 to 4 restructure the proof. Task 5 is optional. Tasks 6 and 7 finish what the predecessor plan still owes.

## File map

| File | Responsibility |
|---|---|
| `docs/superpowers/specs/2026-08-10-workspace-web-tab-packaged-proof-design.md` | Amended to record the shipped browser chrome, the wheel-forwarding opt-out, and the relocated lifecycle proof. |
| `crates/buzz-browser/src/host.rs` | Real-launch tests proving an owned browser exposes a PID and its process tree disappears on host drop. |
| `desktop/src-tauri/src/web_lifecycle_tests.rs` | New. `WebManager` lifecycle tests over a real browser via `tauri::test::mock_app`, kept out of `web.rs` for the 1000-line ceiling. |
| `desktop/src-tauri/src/web.rs` | Declares the new test module under `#[cfg(test)]`; no production change. |
| `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts` | Shrunk to one session: real CDP frame, full-surface assertion, input, screenshot, single close. |
| `desktop/e2e-real-shell/README.md` | Documents the narrowed flow 08 scope and where lifecycle is now proven. |
| `scripts/build-real-shell-app.sh` | Optional Task 5 only: harness frontend served from a URL instead of embedded. |
| `desktop/src-tauri/capabilities/wdio.json.harness` | Optional Task 5 only: `remote.urls` so a remote-origin harness webview can still invoke commands. |
| `docs/superpowers/OVERNIGHT-2026-08-10.md` | Factual evidence record for this run. |

---

### Task 1: Record the unplanned changes against the design

Two shipped changes are absent from the approved design. A reviewer reading the design today would not know the browser chrome exists or why a wheel opt-out attribute was added. This task is documentation only, no code.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-workspace-web-tab-packaged-proof-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: an amended design that Tasks 2 to 4 are allowed to diverge from.

- [ ] **Step 1: Read the two commits being recorded**

Run:

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab
git show --stat 44055c13f1 31d209a304 ff3ec194b3 b4458f2b66
```

Expected: four commits touching `webKind.tsx`, `web.rs`, `useWebviewScrollBoundaryLock.ts`, `playwright.config.ts`, the flow 08 spec, and the web fixture.

- [ ] **Step 2: Append the amendment section**

Add this section to the end of `docs/superpowers/specs/2026-08-10-workspace-web-tab-packaged-proof-design.md`, immediately before `## Out of scope`:

```markdown
## Amendments after first packaged run

### Browser chrome and responsive viewport (commits 44055c13f1, 31d209a304, ff3ec194b3)

The spike's toolbar exposed the DevTools endpoint and target id as primary
controls and let the screencast image letterbox inside the panel. Shipped
instead: Back, Forward, Reload, a single URL field with a visible Go control,
and the endpoint/target attach controls collapsed under an "Advanced
connection" disclosure that is closed by default. The screencast surface fills
the workspace panel, and a `ResizeObserver` drives `workspace_web_resize` so
Chromium's CDP viewport tracks the panel instead of the image being stretched
or cropped.

Two native commands were added for this: `workspace_web_back`,
`workspace_web_forward`, `workspace_web_reload`, and `workspace_web_resize`.

### Wheel forwarding opt-out (commit b4458f2b66)

`useWebviewScrollBoundaryLock` registers a window-capture, `passive: false`
wheel listener that calls `preventDefault()` and `stopPropagation()` on any
wheel whose event path contains no scrollable element. The screencast surface
is deliberately `overflow-hidden`, so it matched that rule and every wheel over
the Web tab was consumed before React's `onWheel` could run. Remote scrolling
never worked, in any environment. This was previously misdiagnosed as a
packaged WebKit/Tauri boundary limitation.

Surfaces that forward wheel gestures somewhere else now opt out with
`data-buzz-wheel-forwarding`, matching the existing
`data-buzz-conversation-scroll` exemption idiom. Rubber-band protection is
unchanged and `tests/e2e/overscroll-boundary.spec.ts` still passes.

### Proof layering

The packaged WDIO journey is no longer the place where input and lifecycle are
iterated. Engine input behaviour is proven by the `engine-chromium` and
`engine-webkit` Playwright projects, because WebKit is the engine behind the
packaged macOS WKWebView. Owned-browser process lifecycle is proven by Rust
integration tests against real headless Chromium. Flow 08 keeps only the proof
that requires the signed bundle: real Tauri IPC producing a real CDP frame
inside the packaged app, plus a screenshot.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-10-workspace-web-tab-packaged-proof-design.md
git commit -s -m "docs(workspace): record shipped web tab chrome and wheel fix"
git push origin feat/workspace-web-tab
```

Expected: push succeeds, remote SHA matches local.

---

### Task 2: Prove owned browser lifecycle in `buzz-browser`

`BrowserHost` already kills its owned process in `Drop` (`crates/buzz-browser/src/host.rs:229`), and `real_launch_lists_a_page_target` already launches a real browser under `BUZZ_BROWSER_REAL=1`. Nothing asserts that the process actually disappears. That assertion is the one flow 08 currently spends a whole browser session on.

**Files:**
- Modify: `crates/buzz-browser/src/host.rs` (the existing `#[cfg(test)] mod tests` at line 304)

**Interfaces:**
- Consumes: `launch(&HostConfig) -> Result<BrowserHost, BrowserError>`, `BrowserHost::process_id() -> Option<u32>`, `BrowserHost::owns_browser_process() -> bool`.
- Produces: `process_is_alive(pid: u32) -> bool` and `wait_for_pid_gone(pid: u32, timeout: Duration) -> bool`, both test-only helpers reused by Task 3's assertions in spirit but not imported across crates.

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/buzz-browser/src/host.rs`:

```rust
    /// `ps -p` rather than a raw `kill(pid, 0)`: this crate forbids `unsafe`,
    /// and a reaped-but-unwaited zombie must still read as gone.
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

    async fn wait_for_pid_gone(pid: u32, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while tokio::time::Instant::now() < deadline {
            if !process_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test]
    #[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
    async fn real_owned_launch_exposes_a_pid_and_reaps_it_on_drop() {
        if std::env::var("BUZZ_BROWSER_REAL").is_err() {
            return;
        }
        let pid = {
            let host = launch(&HostConfig::default()).await.unwrap();
            assert!(
                host.owns_browser_process(),
                "a launched host must own its browser process"
            );
            let pid = host
                .process_id()
                .expect("an owned launch must expose a browser PID");
            assert!(
                process_is_alive(pid),
                "the launched browser {pid} was not running"
            );
            pid
        };

        assert!(
            wait_for_pid_gone(pid, std::time::Duration::from_secs(30)).await,
            "owned browser {pid} survived the host drop"
        );
    }
```

- [ ] **Step 2: Run the test against unrepaired code and capture the failure**

First confirm the test genuinely exercises teardown. Temporarily neutralize the kill inside `impl Drop for BrowserHost` (around `crates/buzz-browser/src/host.rs:229`) by adding `return;` as the first line of `fn drop`, then run:

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab
BUZZ_BROWSER_REAL=1 cargo test -p buzz-browser --lib \
  real_owned_launch_exposes_a_pid_and_reaps_it_on_drop -- --ignored --nocapture
```

Expected: FAIL with `owned browser <pid> survived the host drop`. Record the exact message. Then remove the `return;` you added and confirm `git diff crates/buzz-browser/src/host.rs` shows only the new test code.

If any Chromium process leaked during this deliberate-failure run, kill it before continuing:

```bash
ps -axo pid=,command= | rg "remote-debugging-port" || true
```

- [ ] **Step 3: Run the test green**

```bash
BUZZ_BROWSER_REAL=1 cargo test -p buzz-browser --lib \
  real_owned_launch_exposes_a_pid_and_reaps_it_on_drop -- --ignored --nocapture
```

Expected: PASS in under 30 seconds, no leftover Chromium.

- [ ] **Step 4: Confirm the existing host tests still pass**

```bash
cargo test -p buzz-browser --lib host
cargo fmt --all -- --check
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/buzz-browser/src/host.rs
git commit -s -m "test(browser): prove an owned browser is reaped on host drop"
git push origin feat/workspace-web-tab
```

---

### Task 3: Prove `WebManager` lifecycle without the packaged app

This is the task that removes the visible open/close churn. `WebManager::start` needs a Tauri `AppHandle`, and `tauri = { features = ["test"] }` is already a dev-dependency of the desktop crate, so `tauri::test::mock_app()` supplies one with no window and no packaged build.

`web.rs` is 976 lines against a 1000-line ceiling, so these tests go in a sibling module file.

**Files:**
- Create: `desktop/src-tauri/src/web_lifecycle_tests.rs`
- Modify: `desktop/src-tauri/src/web.rs` (add the module declaration only)

**Interfaces:**
- Consumes: `WebManager::default()`, `WebManager::start(AppHandle, WebStartRequest) -> Result<WebStartResult, String>`, `WebManager::close(&str) -> Result<(), String>`, `WebManager::close_all_async() -> Result<(), String>`, `WebStartRequest { endpoint: Option<String>, target_id: Option<String>, url: String }`, `WebStartResult { session_id: String, target_id: String, url: String, owns_browser_process: bool, browser_pid: Option<u32> }`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `desktop/src-tauri/src/web_lifecycle_tests.rs`:

```rust
//! Owned-browser lifecycle for `WebManager`, against a real headless Chromium.
//!
//! These tests replace the three visible browser sessions the packaged WDIO
//! journey used to open. `tauri::test::mock_app` supplies a real `AppHandle`
//! with no window, so a full session can be started and torn down in seconds
//! without a packaged build.
//!
//! Gated on `BUZZ_BROWSER_REAL=1` because they launch an actual browser.
use std::time::Duration;

use crate::web::{WebManager, WebStartRequest};

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

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn closing_a_session_reaps_the_browser_it_owns() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = WebManager::default();

    let started = manager
        .start(app.handle().clone(), owned_request())
        .await
        .expect("owned web session failed to start");
    assert!(started.owns_browser_process());
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
}

#[tokio::test]
#[ignore = "requires a real browser; run with BUZZ_BROWSER_REAL=1"]
async fn close_all_reaps_every_owned_browser() {
    if std::env::var("BUZZ_BROWSER_REAL").is_err() {
        return;
    }
    let app = tauri::test::mock_app();
    let manager = WebManager::default();

    let first = manager
        .start(app.handle().clone(), owned_request())
        .await
        .expect("first owned web session failed to start");
    let second = manager
        .start(app.handle().clone(), owned_request())
        .await
        .expect("second owned web session failed to start");

    let pids: Vec<u32> = [first.browser_pid, second.browser_pid]
        .into_iter()
        .map(|pid| pid.expect("an owned session must expose a browser PID"))
        .collect();
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
```

- [ ] **Step 2: Declare the module**

At the end of `desktop/src-tauri/src/web.rs`, after the existing `#[cfg(test)] mod tests { ... }` block, add:

```rust
#[cfg(test)]
#[path = "web_lifecycle_tests.rs"]
mod web_lifecycle_tests;
```

If `WebStartRequest`, `WebStartResult`, or `WebManager` are not already `pub` at crate level, they are (`web.rs:42`, `web.rs:53`, `web.rs:184`). If the `close` or `close_all_async` methods are private, make them `pub(crate)`; do not widen them further.

- [ ] **Step 3: Run the tests against unrepaired code and capture the failure**

Temporarily neutralize teardown so the tests are proven red. In `desktop/src-tauri/src/web.rs`, in `pub async fn close`, add `return Ok(());` as the first line. Then:

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab
BUZZ_BROWSER_REAL=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  web_lifecycle_tests -- --ignored --nocapture --test-threads=1
```

Expected: `closing_a_session_reaps_the_browser_it_owns` FAILS with `browser <pid> survived session close`. Record the message, remove the `return Ok(());`, and confirm `git diff desktop/src-tauri/src/web.rs` shows only the module declaration.

Kill any browser leaked by the deliberate failure:

```bash
ps -axo pid=,command= | rg "remote-debugging-port" || true
```

- [ ] **Step 4: Run the tests green**

```bash
BUZZ_BROWSER_REAL=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  web_lifecycle_tests -- --ignored --nocapture --test-threads=1
```

Expected: both tests PASS, no Chromium remains, total runtime well under a minute.

- [ ] **Step 5: Run the focused gates**

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml web::tests
cargo fmt --all -- --check
cd desktop && pnpm check:file-sizes
```

Expected: green, and `web.rs` still under 1000 lines. Do not run workspace-wide clippy or tests.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/web_lifecycle_tests.rs desktop/src-tauri/src/web.rs
git commit -s -m "test(workspace): prove web session teardown without the packaged app"
git push origin feat/workspace-web-tab
```

---

### Task 4: Shrink flow 08 to the proof only it can carry

With Tasks 2 and 3 green, three of flow 08's four proofs are covered somewhere faster. What remains packaged-only: real Tauri IPC inside the signed bundle producing a real CDP frame, the frame filling the workspace surface, forwarded input reaching the remote page, and a screenshot a human can look at.

This drops flow 08 from three browser sessions plus a community switch plus an app quit to a single session.

**Files:**
- Modify: `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts`
- Modify: `desktop/e2e-real-shell/README.md`

**Interfaces:**
- Consumes: `createOwnedWeb(url)`, `proveFixtureInput(fixture, frame)`, `startWebFixture()`, `recordResult(name, status, detail)` from the existing spec and helpers.
- Produces: `desktop/e2e-real-shell/results/08-web.png`.

- [ ] **Step 1: Delete the lifecycle sections from the spec body**

In `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts`, the `it(...)` body currently runs three sessions. Replace the body between `const fixture = await startWebFixture();` and the `catch` block with:

```ts
    try {
      await enableWebPreview();
      await ensureJoinedCommunity(RELAY_A);
      await openWorkspace();

      // One session only. Tab-close, community-reset, and app-quit reaping are
      // proven in desktop/src-tauri/src/web_lifecycle_tests.rs against a real
      // headless Chromium, which does not need a packaged build and does not
      // flash windows at whoever is watching. What is packaged-only is this:
      // real Tauri IPC inside the signed bundle producing a real CDP frame.
      const session = await createOwnedWeb(fixture.url);
      const tree = await trackedTree(session.pid, "packaged browser");
      await proveFixtureInput(fixture, session.frame);
      await browser.saveScreenshot("./e2e-real-shell/results/08-web.png");

      const tab = await $('[data-testid^="workspace-tab-"]');
      await tab.moveTo();
      const close = await tab.$('button[aria-label="Close Web"]');
      await close.waitForExist({ timeout: 30_000 });
      await close.click();
      // Kept because this run owns these processes and must not leak them,
      // not as the lifecycle proof.
      await proveGone("packaged browser tree", tree);

      recordResult(
        "08-workspace-web",
        "pass",
        `fixture=${fixture.url} browserPid=${session.pid}`,
      );
    } catch (cause: unknown) {
```

- [ ] **Step 2: Remove the code that is now unreachable**

Delete these now-unused declarations from the same file: `RELAY_B`, `PersistedCommunity`, `PersistedCommunityState`, `persistedCommunityState`, `addAndSwitchToCommunityB`, `waitForCommunityReady`, `detachWdioSession`, and the `waitForProcessWhere` import if nothing else uses it. Keep `processTree`, `psFindWhere`, and `waitForPidsGone`.

- [ ] **Step 3: Update the test title**

Change the `it(...)` title from `"proves real CDP frames, input, and owned browser cleanup"` to `"renders a real CDP frame and forwards input inside the packaged app"`.

- [ ] **Step 4: Typecheck the harness**

```bash
cd desktop
pnpm harness:typecheck
pnpm exec biome check --write e2e-real-shell/specs/08-workspace-web.spec.ts
```

Expected: no unused-import or unused-variable errors. If any remain, they name code Step 2 missed; delete it.

- [ ] **Step 5: Update the harness README**

In `desktop/e2e-real-shell/README.md`, find the flow 08 entry and replace its description with:

```markdown
- **08 workspace web** — packaged Tauri launches an owned headless Chromium,
  renders a real `Page.startScreencast` frame filling the workspace surface,
  and forwards pointer and keyboard input to a loopback fixture that reports
  exact receipts. Produces `results/08-web.png`.

  Scope note: owned-browser reaping on tab close, community reset, and app quit
  is **not** proven here. It is proven in
  `desktop/src-tauri/src/web_lifecycle_tests.rs` and
  `crates/buzz-browser/src/host.rs` against a real headless Chromium, which
  runs in seconds without a packaged build. Engine input quirks are proven by
  the `engine-chromium` and `engine-webkit` Playwright projects. Flow 08 keeps
  only the proof that requires the signed bundle.
```

- [ ] **Step 6: Commit**

```bash
git add desktop/e2e-real-shell/specs/08-workspace-web.spec.ts desktop/e2e-real-shell/README.md
git commit -s -m "test(workspace): narrow packaged web flow to bundle-only proof"
git push origin feat/workspace-web-tab
```

Do not run the packaged flow yet. Task 6 runs it once.

---

### Task 5 (OPTIONAL): Serve the harness frontend from a URL

**Decision gate. Read this before starting.**

The packaged harness embeds its frontend (`frontendDist: "../dist"`), so any UI change forces a full Tauri release rebuild, observed at 23 minutes cold and several minutes warm. Tauri 2 accepts a URL for `frontendDist` (`FrontendDist::Url`, verified in `tauri-utils-2.9.3/src/config.rs:3263`), which would drop a UI-only iteration to roughly 20 seconds.

**Recommendation: skip this unless a later change forces repeated packaged UI iteration.** After Tasks 2 to 4, flow 08 runs about once per branch, so the rebuild tax is mostly gone already. This task adds real risk: the harness webview would run on an `http://127.0.0.1:4173` origin instead of the Tauri asset origin, which changes the localStorage partition the flow seeds, changes the CSP `'self'` origin, and requires `remote.urls` on every capability the app uses. Skipping it costs nothing that Tasks 2 to 4 have not already recovered.

If the gate says skip, mark this task complete with a one-line note and move to Task 6.

**Files:**
- Modify: `scripts/build-real-shell-app.sh`
- Modify: `desktop/src-tauri/capabilities/wdio.json.harness`

- [ ] **Step 1: Add remote origin permission to the harness capability template**

Replace the contents of `desktop/src-tauri/capabilities/wdio.json.harness` with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "wdio-harness",
  "description": "WebDriverIO test permissions. Template: materialized as wdio.json only for harness builds (scripts/build-real-shell-app.sh), so shipping builds never load it.",
  "windows": ["main"],
  "remote": {
    "urls": ["http://127.0.0.1:4173/*"]
  },
  "permissions": [
    "wdio:default",
    "wdio-webdriver:default"
  ]
}
```

- [ ] **Step 2: Point the harness build at the served origin**

In `scripts/build-real-shell-app.sh`, add `"frontendDist": "http://127.0.0.1:4173"` inside the existing `"build"` object of the `--config` JSON passed to `pnpm exec tauri build`.

- [ ] **Step 3: Serve the harness bundle during the run**

In `scripts/run-real-shell-e2e.sh`, before the flow loop, start a static server on the harness bundle and register its teardown in the existing cleanup trap:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 -d desktop/dist &
HARNESS_FRONTEND_PID=$!
```

- [ ] **Step 4: Prove the round trip**

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab
export BUZZ_HARNESS_RELAY_PORT=3040 BUZZ_HARNESS_PG_PORT=5481
export BUZZ_HARNESS_REDIS_PORT=6481 BUZZ_HARNESS_MINIO_PORT=9481
export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
./scripts/run-real-shell-e2e.sh --flow 01
```

Expected: flow 01 passes against the served frontend. If it fails on capability or CSP grounds, revert this task entirely (`git checkout -- scripts/ desktop/src-tauri/capabilities/`) and record why. Do not spend more than one build proving it.

- [ ] **Step 5: Commit or revert**

On success:

```bash
git add scripts/build-real-shell-app.sh scripts/run-real-shell-e2e.sh desktop/src-tauri/capabilities/wdio.json.harness
git commit -s -m "test(harness): serve the packaged harness frontend from a URL"
git push origin feat/workspace-web-tab
```

On failure, revert and note the failure in Task 7's evidence record.

---

### Task 6: Run the packaged proof once and inspect it

This discharges Task 5 steps 5 and 6 of the predecessor plan. The last recorded flow 08 result is `fail` (`remote input never received the forwarded pointer`, 2026-08-10T09:52:46Z), from before the fixture viewport fix in `ff3ec194b3` and before the wheel fix in `b4458f2b66`. Neither has been validated in a packaged run.

**Files:**
- Verify only. No source changes unless a real defect is found, in which case fix it under its own red-before-green cycle and rerun with `--no-build`.

- [ ] **Step 1: Check disk before building**

```bash
df -h /
```

Expected: at least 40 GB free. If below, follow the documented stale-target protocol and record every deletion and the amount reclaimed.

- [ ] **Step 2: Run the focused gates that gate the packaged build**

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab/desktop
pnpm build:e2e
pnpm exec playwright test --project=engine-chromium --project=engine-webkit
pnpm exec playwright test tests/e2e/workspace-web.spec.ts tests/e2e/overscroll-boundary.spec.ts --project=smoke
pnpm typecheck
pnpm harness:typecheck
pnpm check:native-bridge-boundary
pnpm check:px-text
pnpm check:file-sizes
pnpm check:native-inventory
```

Expected: all green. `engine-chromium` plus `engine-webkit` is 8 tests in roughly 25 seconds.

- [ ] **Step 3: Build once and run flow 08**

```bash
cd /Users/mac/.traycer/worktrees/ai-native-ventures__colony/feat-workspace-web-tab
. ./bin/activate-hermit
export BUZZ_HARNESS_RELAY_PORT=3040 BUZZ_HARNESS_PG_PORT=5481
export BUZZ_HARNESS_REDIS_PORT=6481 BUZZ_HARNESS_MINIO_PORT=9481
export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
./scripts/run-real-shell-e2e.sh --flow 08
```

Expected: `desktop/e2e-real-shell/results/flow-results.jsonl` gains a `"status":"pass"` line for `08-workspace-web`.

If it fails: read the failure, decide whether it is product or harness, fix it under a red-before-green cycle, and rerun with `./scripts/run-real-shell-e2e.sh --no-build --flow 08` if the fix did not touch the bundle. **Do not iterate more than twice here.** A third failure means the proof belongs at a lower layer; stop, record it, and report rather than continuing to rebuild.

- [ ] **Step 4: Inspect the screenshot with your own eyes**

```bash
shasum -a 256 desktop/e2e-real-shell/results/08-web.png
```

Then read the PNG with the Read tool. It must visibly show: the Colony window, one URL bar with no visible DevTools endpoint or target id field, the remote fixture page filling the panel with no grey gutters, and the fixture's PASS state. A blank or letterboxed frame is a failure regardless of what the ledger says.

- [ ] **Step 5: Prove cleanup**

```bash
lsof -nP -iTCP:3040 -iTCP:5481 -iTCP:6481 -iTCP:9481 -iTCP:8098 -iTCP:9212 || true
ps -axo pid=,ppid=,command= | rg "Colony.app|remote-debugging-port|buzz-harness-3040" || true
git status --short
```

Expected: no task-owned Colony or Chromium process remains, and the worktree is clean apart from intended result artifacts.

- [ ] **Step 6: Commit the evidence artifacts**

```bash
git add desktop/e2e-real-shell/results/08-web.png desktop/e2e-real-shell/results/flow-results.jsonl
git commit -s -m "test(workspace): record packaged web tab proof artifacts"
git push origin feat/workspace-web-tab
```

---

### Task 7: Evidence record and pull request

This discharges Task 6 of the predecessor plan, plus the design's stated broad acceptance gate: hosted PR CI.

**Files:**
- Create or update: `docs/superpowers/OVERNIGHT-2026-08-10.md`

- [ ] **Step 1: Write the evidence record**

Create or update `docs/superpowers/OVERNIGHT-2026-08-10.md`. Keep these states strictly separate and do not blur them: implemented, focused-locally-tested, packaged-locally-proven, committed, pushed, PR open, hosted CI passed, merged. Record, with exact values:

- every commit SHA produced by this plan and what it proves;
- the red-before-green failure message captured for each new test in Tasks 2 and 3;
- the wheel defect: what it was, why it was previously misread as a packaged WebKit/Tauri limitation, and the commit that fixed it;
- flow 08's final ledger line and the `08-web.png` sha256;
- the PID absence evidence now produced by the Rust tests rather than the packaged flow;
- what remains unproven, named explicitly;
- the Task 5 decision: skipped, or attempted with its outcome;
- that broad local CI was skipped by owner instruction.

- [ ] **Step 2: Commit and push**

```bash
. ./bin/activate-hermit
git add docs/superpowers/OVERNIGHT-2026-08-10.md
git commit -s -m "docs(workspace): record packaged web tab proof"
git push origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
git status --short --branch
```

Expected: local and remote SHAs match, worktree clean.

- [ ] **Step 3: Open the pull request into develop**

```bash
gh pr create --repo AI-Native-Ventures/Colony \
  --base develop --head feat/workspace-web-tab \
  --title "feat(workspace): default-off web tab with packaged CDP proof" \
  --body-file /tmp/web-tab-pr-body.md
```

Write `/tmp/web-tab-pr-body.md` first. It must state what is proven and at which layer, name the wheel defect as a product bug found and fixed, and say plainly that the feature stays default-off.

- [ ] **Step 4: Post the screenshot**

Do not use `buzz upload` or any relay media URL; those fail through GitHub's camo proxy.

```bash
mkdir -p /tmp/web-tab-shots
cp desktop/e2e-real-shell/results/08-web.png /tmp/web-tab-shots/01-packaged-web-tab.png
./scripts/post-screenshots.sh <PR-NUMBER> /tmp/web-tab-shots
```

- [ ] **Step 5: Watch hosted CI to completion**

```bash
gh pr checks <PR-NUMBER> --repo AI-Native-Ventures/Colony --watch
```

Every non-skipped check must read `pass` before the PR is described as green. A red or pending check is an absolute stop. Do not merge; report the state and hand back.

---

## Self-review

**Spec coverage.** The predecessor design's requirements map as follows: reconciliation, default-off behaviour, real owned launch, real frame, input receipts, and the visible screenshot stay in Task 6. Tab-close, community-reset, and app-quit cleanup move to Tasks 2 and 3, and Task 1 amends the design to say so, since the original text put them in flow 08. Attached-process ownership is already covered by the existing `real_attach_drives_a_browser_it_did_not_launch` test. Focused-gates-only and no-broad-CI are in Global Constraints. Hosted PR CI as the broad gate is Task 7.

**Placeholder scan.** Every step has exact paths, exact commands, exact expected failures, and literal code. Task 5 is deliberately gated with a recommendation to skip rather than left vague, and its abort condition is a single build.

**Type consistency.** `WebStartResult.browser_pid` is `Option<u32>` in Rust and `browserPid: number | null` in the frontend, unchanged by this plan. `process_is_alive`/`wait_for_pid_gone` are defined twice on purpose, once per crate, because they are test-only helpers and neither crate exports test utilities to the other. Task 4's spec edits reference only helpers that already exist in `08-workspace-web.spec.ts` (`createOwnedWeb`, `proveFixtureInput`, `trackedTree`, `proveGone`, `startWebFixture`, `recordResult`, `enableWebPreview`, `ensureJoinedCommunity`, `openWorkspace`).

**Known risk.** Task 3 depends on `tauri::test::mock_app()` supporting a real `AppHandle` for a crate whose `run_session` emits window events. The dev-dependency is already present with the `test` feature and is already used elsewhere in this crate for path-resolver work. If `mock_app` cannot carry the emit path, Task 3's fallback is to assert the same lifecycle one layer down through `open_host` plus explicit `WebManager` session bookkeeping, which still needs no packaged build. Record which path was taken.
