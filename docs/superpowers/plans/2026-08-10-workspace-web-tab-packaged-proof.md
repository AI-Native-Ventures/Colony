# Workspace Web Tab Packaged Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the default-off Web workspace-tab spike onto merged `develop` and prove, through a packaged Tauri app, that an owned Chromium CDP screencast renders, accepts input, and is reaped at every lifecycle boundary.

**Architecture:** Keep the workspace shell kind-agnostic: the Web tab registers a body and dispose hook, the frontend session owner calls only `NativeBridge`, and Tauri's `WebManager` delegates browser launch/attach to `buzz-browser`. The packaged proof uses a loopback-only HTTP fixture and an owned headless browser, exposes its PID only in runtime state, and checks real UI receipts plus OS process disappearance. The preview flag remains default-off.

**Tech Stack:** React 19, TypeScript, Tauri 2/Rust, `buzz-browser`, Chrome DevTools Protocol screencast/input APIs, WebdriverIO packaged-app harness, Node HTTP fixture.

---

## File map

| File | Responsibility |
|---|---|
| `crates/buzz-browser/src/host.rs` | Report an owned browser PID without changing attach ownership semantics. |
| `desktop/src-tauri/src/web.rs` | Return runtime-only PID metadata and retain bounded WebManager teardown. |
| `desktop/src/features/workspace/lib/webSessions.ts` | Hold owned PID in module runtime state, never in tab payload. |
| `desktop/src/features/workspace/lib/webSessions.test.mjs` | Red/green coverage for runtime PID propagation and lifecycle fences. |
| `desktop/src/features/workspace/kinds/webKind.tsx` | Render the screencast and expose status/PID only as test-observable data attributes. |
| `desktop/src/testing/e2eBridge.ts` | Mirror the native start result for the focused mock journey. |
| `desktop/tests/e2e/workspace-web.spec.ts` | Default-off and enabled mock contract coverage. |
| `desktop/e2e-real-shell/helpers/web-fixture.ts` | Loopback fixture page and exact page-side input receipts. |
| `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts` | Packaged real-Tauri CDP frame, input, screenshot, and lifecycle proof. |
| `scripts/run-real-shell-e2e.sh` | Register flow 08 in the documented/default flow inventory without changing per-flow isolation. |
| `desktop/e2e-real-shell/README.md` | Document the new flow, artifact, and focused invocation. |
| `desktop/native-inventory.json` | Mechanically regenerated native-command/event inventory after reconciliation. |

## Deferred roadmap insertion — not part of this implementation

Insert this future item **after step 2b, durable browser profiles, and before step 2e, grant gating**:

**Step 2c — selective cookie import from installed Chrome-family browsers.** A human-only picker discovers Chrome, Chromium, Arc, Brave, Edge, and Comet; lets the human select browser, profile, and domains; copies locked cookie databases to a temporary directory; decrypts only the selected domains; deletes every temporary database/WAL/SHM copy; and injects cookies into the selected Web-tab session with CDP `Network.setCookie`. Cookie values never enter logs, events, persisted workspace payloads, screenshots, or test failure messages. Keychain denial and cancellation are named errors. The implementation must inspect the installed Chrome version, support Windows Chrome 127+ App-Bound encryption and its 32-byte domain-hash prefix, and use the same authorization grant as authenticated durable profiles. Tests begin with fixture cookie databases and must fail before implementation; acceptance includes one manual signed-in Chrome proof with a redacted screenshot. Cookie import ships in its own signed commit, separate from durable profile persistence.

Before that future step changes code, read these reference implementations in full:

- `~/.claude/skills/gstack/browse/src/cookie-import-browser.ts`
- `~/.claude/skills/gstack/browse/src/cookie-picker-ui.ts`
- `~/.claude/skills/gstack/browse/src/cookie-picker-routes.ts`

The references establish the browser/profile/domain discovery shape, one-time picker authorization, temporary SQLite copy cleanup, selected-domain filtering, platform decryptors, Chrome v20/App-Bound fallback, and the invariant that cookie values never appear in the picker UI. Colony will adapt those mechanisms to Rust/Tauri and `Network.setCookie`; it will not expose a localhost control API or Playwright cookie store merely because the reference does.

---

### Task 1: Reconcile only Web commits onto merged develop

**Files:**

- Preserve all Web-spike files from commits `3afa448255` and `b12b323712`.
- Preserve merged terminal/shared-file changes from `origin/develop`.
- Regenerate: `desktop/native-inventory.json`.

- [ ] **Step 1: Verify the remote durability checkpoint and clean worktree**

Run:

```bash
. ./bin/activate-hermit
git status --short --branch
git rev-parse HEAD
git ls-remote origin refs/heads/feat/workspace-web-tab
```

Expected: clean branch and identical local/remote `d6214178832bbcd7aaa907d7d7016f0e14fff6db` before history reconciliation.

- [ ] **Step 2: Replay only the Web range**

Run:

```bash
. ./bin/activate-hermit
git fetch origin develop
git rebase --signoff --onto origin/develop 61a386cfa6b3f117bc97e2c4920ad58952cdb64e feat/workspace-web-tab
```

Resolve shared files by retaining merged terminal registration/reset/shutdown/test behavior and adding the Web behavior beside it. Do not replay `7e35ba9565` or `61a386cfa6`; those terminal changes arrived through PR #204.

- [ ] **Step 3: Regenerate derived inventory and check the reconciliation**

Run:

```bash
cd desktop
pnpm generate:native-inventory
pnpm check:native-inventory
cd ..
git diff --check
git range-diff 61a386cfa6..d621417883 origin/develop..HEAD
```

Expected: inventory drift check passes; range-diff contains the two Web commits and documentation, not a second copy of terminal work.

- [ ] **Step 4: Push the reconciled head immediately**

Run:

```bash
. ./bin/activate-hermit
git push --force-with-lease origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
```

Expected: remote SHA equals `git rev-parse HEAD`. The lease limits the rewrite to the feature branch's verified remote head; never rewrite `develop` or `main`.

### Task 2: Add owned-browser PID observability with red-before-green proof

**Files:**

- Modify: `crates/buzz-browser/src/host.rs`.
- Modify: `desktop/src-tauri/src/web.rs`.
- Modify: `desktop/src/features/workspace/lib/webSessions.ts`.
- Modify: `desktop/src/features/workspace/lib/webSessions.test.mjs`.
- Modify: `desktop/src/features/workspace/kinds/webKind.tsx`.
- Modify: `desktop/src/testing/e2eBridge.ts`.

- [ ] **Step 1: Write the frontend failing test**

Extend the fake `workspace_web_start` result with `browserPid: 4242`, then assert:

```js
assert.equal(getWebSession("tab-web").browserPid, 4242);
assert.equal(getWebSession("tab-web").ownsBrowserProcess, true);
```

Also assert an attached result with `ownsBrowserProcess: false` carries `browserPid: null`.

- [ ] **Step 2: Run the new test against unrepaired code**

Run:

```bash
cd desktop
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/workspace/lib/webSessions.test.mjs
```

Expected: FAIL because `WebSessionState` does not yet retain `browserPid`.

- [ ] **Step 3: Add the minimal runtime-only contract**

Add this documented API to `BrowserHost`:

```rust
/// Process identifier for a browser launched and owned by this host.
/// Attached browsers return `None` because their process is externally owned.
pub fn process_id(&self) -> Option<u32> {
    self.child.as_ref().and_then(tokio::process::Child::id)
}
```

Add `browser_pid: Option<u32>` to `WebStartResult`, populated before the host moves into the session task. Mirror it as `browserPid: number | null` in frontend runtime state and expose it on the Web body as `data-browser-pid`. Do not add it to `WebPayload`, `createPayload`, or `updateTabPayload`.

- [ ] **Step 4: Run focused green tests**

Run:

```bash
cd desktop
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/workspace/lib/webSessions.test.mjs
cd ..
cargo test -p buzz-browser host --lib
cargo test --manifest-path desktop/src-tauri/Cargo.toml web::tests
```

Expected: PID propagation passes, attached hosts report no owned PID, and WebManager lifecycle tests remain green.

- [ ] **Step 5: Commit and push immediately**

Run:

```bash
. ./bin/activate-hermit
git add crates/buzz-browser/src/host.rs desktop/src-tauri/src/web.rs \
  desktop/src/features/workspace/lib/webSessions.ts \
  desktop/src/features/workspace/lib/webSessions.test.mjs \
  desktop/src/features/workspace/kinds/webKind.tsx \
  desktop/src/testing/e2eBridge.ts desktop/native-inventory.json
git commit -s -m "test(workspace): expose owned web process proof"
git push origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
```

### Task 3: Build the deterministic loopback Web fixture

**Files:**

- Create: `desktop/e2e-real-shell/helpers/web-fixture.ts`.
- Create: `desktop/e2e-real-shell/helpers/web-fixture.test.mjs`.

- [ ] **Step 1: Write fixture contract tests before the server**

The test must require:

```js
assert.equal(receipts.inputValues.join(","), "colony-web");
assert.equal(receipts.actions, 1);
assert.ok(receipts.maxScrollY > 0);
assert.equal(receipts.pass, true);
```

It must also prove the server binds to `127.0.0.1` on an ephemeral port and closes in `finally`.

- [ ] **Step 2: Run the fixture test and capture the failure**

Run:

```bash
cd desktop
node --import ./test-loader.mjs --experimental-strip-types --test \
  e2e-real-shell/helpers/web-fixture.test.mjs
```

Expected: FAIL because `startWebFixture` is absent.

- [ ] **Step 3: Implement the fixture**

Export:

```ts
export type WebFixture = {
  url: string;
  receipts: () => Readonly<WebFixtureReceipts>;
  close: () => Promise<void>;
};

export async function startWebFixture(): Promise<WebFixture>;
```

Serve a visually distinct page containing `#remote-input`, `#remote-action`, `#remote-status`, and a tall scroll region. Page listeners POST JSON receipts to the same loopback server. The server sets `pass` only when the exact final input value is `colony-web`, exactly one action is received, and positive scroll is observed. The rendered status must switch to a large `PASS` marker so the screencast screenshot is human-verifiable.

- [ ] **Step 4: Run the fixture test green**

Run the command from Step 2. Expected: PASS with no listener left open.

- [ ] **Step 5: Commit and push immediately**

Run:

```bash
. ./bin/activate-hermit
git add desktop/e2e-real-shell/helpers/web-fixture.ts \
  desktop/e2e-real-shell/helpers/web-fixture.test.mjs
git commit -s -m "test(workspace): add deterministic web tab fixture"
git push origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
```

### Task 4: Add packaged flow 08

**Files:**

- Create: `desktop/e2e-real-shell/specs/08-workspace-web.spec.ts`.
- Modify: `desktop/e2e-real-shell/helpers/process.ts` only if a reusable explicit absence reporter is required.
- Modify: `scripts/run-real-shell-e2e.sh`.
- Modify: `desktop/e2e-real-shell/README.md`.

- [ ] **Step 1: Register the flow before creating its spec**

Add flow 08 to the runner's inventory/default list and run:

```bash
./scripts/run-real-shell-e2e.sh --no-build --flow 08
```

Expected: FAIL with `no spec found for flow 08`. This is the captured red proof that the runner actually selects the new journey.

- [ ] **Step 2: Implement isolated feature enablement**

In the packaged spec, write only this override before reloading:

```ts
await browser.execute(() => {
  window.localStorage.setItem(
    "buzz-feature-overrides-v1",
    JSON.stringify({ workspaceWebTab: true }),
  );
});
await browser.refresh();
```

Then complete onboarding with the existing community helper, open `#general`, enable the workspace, create Web, leave endpoint empty, and navigate to `fixture.url`.

- [ ] **Step 3: Prove the real frame and input path**

Wait for `data-status="running"`, a positive `data-browser-pid`, and a non-empty `<img data-testid="workspace-web-frame">`. Use frame-relative coordinates to click the remote field, send the exact text `colony-web` through the real keyboard path, wheel inside the scroll region, and click the action. Require the loopback server receipts to report exact text once, one action, and positive scroll.

- [ ] **Step 4: Capture a visible PASS frame**

Wait for a later frame after the fixture reports pass, then save:

```ts
await browser.saveScreenshot("./e2e-real-shell/results/08-web.png");
```

The spec must reject a screenshot taken before the fixture's PASS receipt. After the run, inspect it visually; a blank frame, a cursor-only frame, or a pre-action page is a failed proof even when the automation exits zero.

- [ ] **Step 5: Prove all owned-process lifecycle boundaries**

For tab close, community reset, and normal app quit:

1. Capture leader PID plus `processTree(pid)` descendants before the action.
2. Perform the real UI/native action.
3. Call `waitForPidsGone` for the full captured tree.
4. Print exactly `kill-0=false ps=absent` with the action label and PID list.

Start a fresh owned Web session for each boundary. At community switch, require all community-A browser PIDs gone before the keyed community-B readiness marker. For app quit, detach the WDIO session before waiting, matching flow 06's transport-safe shutdown pattern.

- [ ] **Step 6: Commit and push immediately**

Run:

```bash
. ./bin/activate-hermit
git add desktop/e2e-real-shell/specs/08-workspace-web.spec.ts \
  desktop/e2e-real-shell/helpers/process.ts \
  scripts/run-real-shell-e2e.sh desktop/e2e-real-shell/README.md
git commit -s -m "test(workspace): prove packaged web tab journey"
git push origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
```

### Task 5: Run focused gates and the packaged journey

**Files:**

- Verify only; no broad-suite file changes.

- [ ] **Step 1: Check disk before build work**

Run:

```bash
df -h /
```

Expected: at least 40 GB free. Follow the documented stale-target protocol only if below the threshold, and record every deletion/reclaimed amount.

- [ ] **Step 2: Run focused frontend/static gates**

Run:

```bash
cd desktop
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/workspace/lib/webSessions.test.mjs \
  src/features/workspace/kinds/webKind.test.mjs \
  src/features/workspace/kinds/terminalKind.test.mjs \
  e2e-real-shell/helpers/web-fixture.test.mjs
pnpm typecheck
pnpm harness:typecheck
pnpm check:native-bridge-boundary
pnpm check:px-text
pnpm check:file-sizes
pnpm check:native-inventory
```

Expected: every focused command passes. Do not run `pnpm check`, `just ci`, or the broad unit suite.

- [ ] **Step 3: Run focused native gates**

Run:

```bash
cargo test -p buzz-browser host --lib
cargo test --manifest-path desktop/src-tauri/Cargo.toml web::tests
cargo fmt --all -- --check
```

Expected: the Web-specific tests and formatting pass. Do not run workspace-wide Clippy or tests.

- [ ] **Step 4: Run focused mock Playwright proof**

Run:

```bash
cd desktop
pnpm build:e2e
pnpm exec playwright test tests/e2e/workspace-web.spec.ts --project=smoke
```

Expected: default-off and enabled Web tests pass with the E2E bridge intact.

- [ ] **Step 5: Build once and run only packaged flow 08**

Run with the reserved Web harness ports:

```bash
df -h /
export BUZZ_HARNESS_RELAY_PORT=3040 BUZZ_HARNESS_PG_PORT=5481
export BUZZ_HARNESS_REDIS_PORT=6481 BUZZ_HARNESS_MINIO_PORT=9481
export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
./scripts/run-real-shell-e2e.sh --flow 08
```

After fixes that do not affect the bundle, rerun only:

```bash
./scripts/run-real-shell-e2e.sh --no-build --flow 08
```

Expected: ledger `pass`, non-blank `desktop/e2e-real-shell/results/08-web.png` visibly showing fixture PASS inside Colony, and explicit PID absence lines for tab close, community reset, and app quit.

- [ ] **Step 6: Inspect artifacts and ensure cleanup**

Run:

```bash
shasum -a 256 desktop/e2e-real-shell/results/08-web.png
lsof -nP -iTCP:3040 -iTCP:5481 -iTCP:6481 -iTCP:9481 \
  -iTCP:8098 -iTCP:9212 || true
ps -axo pid=,ppid=,command= | rg "Colony.app|remote-debugging-port|buzz-harness-3040" || true
git status --short
```

Expected: the screenshot hash is recorded, no task-owned Colony/Chromium helper remains, and the worktree is clean except for deliberate evidence/report edits.

### Task 6: Final evidence commit and remote verification

**Files:**

- Update: `docs/superpowers/OVERNIGHT-2026-08-10.md` if it exists; otherwise create it with only this run's factual evidence.

- [ ] **Step 1: Record proof boundaries**

Keep these separate: implemented, focused locally tested, packaged locally proven, committed, pushed, PR not opened, CI not run, not merged. Record failures and corrections, skipped broad CI by owner instruction, screenshot path/hash, PID evidence lines, cleanup, and anything still running.

- [ ] **Step 2: Commit and push immediately**

Run:

```bash
. ./bin/activate-hermit
git add docs/superpowers/OVERNIGHT-2026-08-10.md
git commit -s -m "docs(workspace): record packaged web tab proof"
git push origin feat/workspace-web-tab
git ls-remote origin refs/heads/feat/workspace-web-tab
git status --short --branch
```

Expected: local and remote SHAs match, worktree is clean, no PR exists for the Web branch, and no merge claim is made.

## Self-review

- Spec coverage: reconciliation, default-off behavior, real owned launch, real frame, input receipts, visible screenshot, tab/reset/quit cleanup, attached-process ownership, focused gates, and no broad CI are each mapped above.
- Placeholder scan: every current task has exact files, commands, expected failures/passes, and commit boundaries. Cookie import is deliberately a fully specified future roadmap insertion rather than an incomplete current implementation task.
- Type consistency: native `browser_pid` serializes to frontend `browserPid`; frontend state uses `number | null`; attached sessions return `null`; Web payload remains endpoint/target/url only.

