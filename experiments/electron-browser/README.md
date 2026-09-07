# Colony shared browser prototype

An isolated Electron experiment for the owner and an agent to use the same real browser tab. It does not replace the Tauri desktop or connect to production Colony agents yet.

## Run

From this directory, with Node.js and npm installed:

```sh
npm ci
npm start
```

Electron is pinned to 44.2.0. Its first launch may download the runtime. The window appears without requesting focus, before external websites finish loading.

The Colony and Horizon choices select separate persistent browser sessions. Sign in manually in this prototype; an existing login in Codex or Tauri is not inherited. Tabs and browser data remain under ignored `.state/`. Override that location with `COLONY_BROWSER_STATE_DIR` if needed. Close the window normally to flush cookies and stop the broker.

Choose **Read only** or **Interact**, then **Share this tab**. The developer disclosure displays an ephemeral grant file. Connect a compatible stdio MCP client using:

```sh
node src/mcp.mjs /absolute/path/to/the-displayed-grant.json
```

The teammate name is a label in this prototype: sharing a tab does not launch a Colony agent. Tools list the granted tab, read its accessibility tree, capture its image, and click or type using references from the latest observation. There is no agent-supplied JavaScript tool. Type inserts text at the focused position; it does not implicitly replace a field's contents.

**Take control** revokes the grant and queued commands. Mouse and keyboard input also have revocation hooks. Revocation cannot undo an action already dispatched. Changing origin requires a new grant. Closing the app invalidates grants; browser sessions survive.

## Verified locally on 2026-09-07

```sh
npm test
npm run test:electron
```

- Seven Node tests passed, covering scope, controller conflicts, revocation, navigation, malformed authority requests, URL restrictions and a real local Unix socket exchange.
- Seventeen checks passed in two real Electron processes. Three native WebContentsViews attached to the shell; two scripted MCP workers read separate tabs concurrently; a worker typed and clicked a real fixture page; read-only and password guards rejected actions; Colony storage was shared within its business and isolated from Horizon; cookies, local storage and three tabs survived restart; grants did not; stale observations and queued work after takeover failed; screenshot output contained actual page pixels.
- Native computer-use inspection confirmed the complete visible shell and embedded Instagram login page. This was an external page, not the fixture or a screenshot simulation.

Generated evidence is ignored under `evidence/`: structured first/restart reports, a summary with per-process resource samples, `draft-preview.png` showing the worker's result, and `worker-page.png`. `shell.png` captures only the shell WebContents and excludes the native child views; it is not a full-window screenshot.

The browser run used Electron 44.2.0 / Chromium 152.0.7977.76 on this Mac. Resource samples are instantaneous fixture-process working sets, not an idle benchmark or a matched Tauri comparison. Test-phase elapsed time excludes full cold startup. No performance advantage is established.

Corrected during proof: awaiting Electron readiness at ESM module top level blocked startup; cold hidden-page capture needed the debugger screenshot path; and waiting for external navigation before showing the window hid the app during a slow load.

## Remaining acceptance

1. Owner signs into Instagram here; confirm the expected account and authenticated persistence after a normal app restart.
2. Connect an actual Colony worker through the production harness and verify a bounded read task, then a draft task. Scripted MCP transport proof does not establish model behavior.
3. Exercise physical human takeover during real agent work, network interruption, tab crashes and recovery. The current takeover test calls the same manager method directly.
4. Compare matching tabs, page state, machine conditions and repeated CPU/memory measurements with the existing Tauri browser before deciding migration scope.

## Boundaries before production

The broker uses a local Unix socket, so Windows transport is not implemented. This is an unpackaged development app. Persistent profiles rely on Electron's storage implementation and OS file access; this work has not audited encryption at rest. A grant is not protection from another process with the same user's filesystem access.

Remote pages have no Node integration or privileged preload. Shell IPC checks the sender and main frame. Permissions, downloads and popups are denied, so some OAuth flows and production website features will need deliberate support. The prototype has no publication approvals, file uploads, frame targeting, browser extensions, durable audit trail, automatic retries, full MCP conformance certification or production prompt-injection defenses. An interaction grant permits page actions; it does not classify a click as drafting versus publishing.

A migration inventory must cover Tauri IPC/native plugins, existing Rust service lifecycle, key storage, deep links, notifications, updater/signing, installer paths, crash recovery and account migration. Preserve reusable Rust services behind an explicit bridge rather than rewriting them merely because the shell changes. The existing `buzz-browser` remains the comparison implementation; this experiment duplicates a small control surface to test the Electron boundary.
