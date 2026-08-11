# Workspace Web Browser Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the default-off Web-tab spike into a full-panel browser surface with normal browser chrome and a CDP viewport synchronized to the workspace.

**Architecture:** Keep the UI inside `webKind.tsx`, add narrow session helpers in `webSessions.ts`, and add typed navigation/resize commands to the existing Tauri Web manager. Extract validation from `web.rs` into a sibling before adding commands so the native file stays below 1000 lines.

**Tech Stack:** React 19, Tailwind, lucide-react, Tauri 2, Rust, buzz-browser CDP, Playwright, WebdriverIO.

---

### Task 1: Lock the visible browser contract

**Files:**
- Modify: `desktop/tests/e2e/workspace-web.spec.ts`
- Modify: `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts`

- [ ] Add assertions for one URL bar, collapsed advanced controls, browser navigation controls, and a frame whose rendered bounds match its page surface.
- [ ] Run the focused Playwright spec against the current product and retain the failure showing the developer toolbar/full-surface mismatch.
- [ ] Run `pnpm harness:typecheck` after updating packaged helpers.

### Task 2: Add the native viewport and navigation contract

**Files:**
- Create: `desktop/src-tauri/src/web_validation.rs`
- Modify: `desktop/src-tauri/src/web.rs`
- Modify: `desktop/src-tauri/src/commands/web.rs`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src/features/workspace/lib/webSessions.ts`
- Modify: `desktop/src/testing/webE2eBridge.ts`
- Modify: `desktop/native-inventory.json`

- [ ] Move existing URL/input validation functions into `web_validation.rs` without changing behavior.
- [ ] Add `workspace_web_resize`, `workspace_web_back`, `workspace_web_forward`, and `workspace_web_reload` bridge helpers.
- [ ] Implement bounded `Emulation.setDeviceMetricsOverride`, `Page.getNavigationHistory` plus `Page.navigateToHistoryEntry`, and `Page.reload` CDP commands.
- [ ] Add focused unit coverage for dimension validation and the new frontend invocation payloads.
- [ ] Run only the focused web-session tests, focused Tauri web tests, NativeBridge boundary, and native-inventory drift check.

### Task 3: Replace debugger controls with browser chrome

**Files:**
- Modify: `desktop/src/features/workspace/kinds/webKind.tsx`
- Modify: `desktop/src/features/workspace/kinds/webKind.test.mjs`

- [ ] Render Back, Forward, Reload, one URL field, status, and an advanced overflow disclosure.
- [ ] Move endpoint, target ID, and attach/launch wording into the collapsed advanced section.
- [ ] Use a `ResizeObserver` on the page surface to send integer dimensions after a running session is available.
- [ ] Render the frame at `h-full w-full` with no padding or grey centering canvas; rely on synchronized CDP dimensions instead of distortion.
- [ ] Run the focused web-kind/session tests and the registered workspace-web Playwright spec.

### Task 4: Prove the packaged result

**Files:**
- Modify: `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts`
- Modify: `docs/superpowers/OVERNIGHT-2026-08-10.md`

- [ ] Check `df -h /`, rebuild only the packaged Tauri harness, and run only flow 08 on the reserved 3040/5481/6481/9481/9492/8098/9212 ports.
- [ ] Verify the screenshot visibly shows browser chrome, a full-panel nonblank remote page, exact `colony-web` input, and PASS.
- [ ] Verify the log prints `kill-0=false ps=absent` after tab close, community switch, and app quit.
- [ ] Record focused proof, the intentional absence of broad CI, and any unproven wheel behavior in the overnight report.
- [ ] Commit with DCO, push the branch, verify local/remote SHA equality, and tear down only task-owned resources.
