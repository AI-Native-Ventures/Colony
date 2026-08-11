# Workspace Web Scroll Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Web workspace wheel latency and frame-render churn by coalescing wheel input and publishing only the newest frame per animation frame.

**Architecture:** Keep the CDP/Tauri transport unchanged. Add a per-tab wheel dispatcher and a per-session latest-frame queue at the frontend native-session boundary, then exercise both through the existing WebKit/Chromium mock-native bridge with deterministic serialization delay and frame bursts.

**Tech Stack:** React 19, TypeScript, Tauri NativeBridge, Playwright 1.60, Node test runner, Rust/Tokio focused lifecycle tests.

---

## File map

- Modify `desktop/src/testing/webE2eBridge.ts`: deterministic wheel serialization delay, completion timestamps, and frame-burst controls for E2E only.
- Modify `desktop/tests/e2e/workspace-web-input.spec.ts`: real-input burst latency and latest-frame regression in both engine projects.
- Modify `desktop/src/features/workspace/lib/webSessions.ts`: per-tab wheel coalescer, one-in-flight rule, and per-session latest-frame delivery.
- Modify `desktop/src/features/workspace/lib/webSessions.test.mjs`: lifecycle and deterministic scheduler coverage.
- Modify `desktop/src/features/workspace/kinds/webKind.tsx`: expose the current frame scroll offset as a diagnostic test attribute.

### Task 1: Add the deterministic burst probe and capture RED

**Files:**
- Modify: `desktop/src/testing/webE2eBridge.ts`
- Modify: `desktop/tests/e2e/workspace-web-input.spec.ts`
- Modify: `desktop/src/features/workspace/kinds/webKind.tsx`

- [ ] **Step 1: Add mock-native performance controls**

Extend the E2E bridge command record and global controls:

```ts
type WebCommand = {
  command: string;
  payload: unknown;
  completedAtMs?: number;
};

type WebPerformanceControls = {
  emitFrameBurst(count: number): Promise<void>;
  setWheelDelay(delayMs: number): void;
};

declare global {
  interface Window {
    __BUZZ_E2E_WEB_COMMANDS__?: () => WebCommand[];
    __BUZZ_E2E_WEB_PERFORMANCE__?: WebPerformanceControls;
  }
}
```

Model the native one-command-at-a-time path with a promise tail:

```ts
let wheelDelayMs = 0;
let wheelTail: Promise<void> = Promise.resolve();

async function recordWheel(
  command: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const completion = wheelTail.then(async () => {
    if (wheelDelayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, wheelDelayMs));
    }
    record(command, payload, performance.now());
  });
  wheelTail = completion.catch(() => undefined);
  await completion;
}
```

`emitFrameBurst(12)` emits twelve `workspace-web-frame` events for the active mock session with `scrollOffsetY` values `1..12`. Reset restores zero delay and a resolved tail.

- [ ] **Step 2: Add the current-frame diagnostic attribute**

On the screencast image in `webKind.tsx`, expose the production frame metadata without changing behavior:

```tsx
data-frame-scroll-y={session.frame.scrollOffsetY}
```

- [ ] **Step 3: Write the two-engine burst regression**

Drive twelve real wheel events and observe the bridge:

```ts
test("bounds burst wheel latency and commits only the latest frame", async ({
  page,
}) => {
  const centre = await runningFrame(page);
  await page.evaluate(() => {
    window.__BUZZ_E2E_WEB_PERFORMANCE__?.setWheelDelay(25);
  });
  const startedAtMs = await page.evaluate(() => performance.now());
  await page.mouse.move(centre.x, centre.y);
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(3, 24);
  }

  await expect.poll(async () => {
    const inputs = (await commands(page))
      .filter((entry) => entry.command === "workspace_web_wheel")
      .map((entry) => entry.payload.input);
    return inputs.reduce((sum, input) => sum + (input?.deltaY ?? 0), 0);
  }).toBe(288);

  const wheel = (await commands(page)).filter(
    (entry) => entry.command === "workspace_web_wheel",
  );
  const settledAtMs = Math.max(
    ...wheel.map((entry) => entry.completedAtMs ?? startedAtMs),
  );
  expect(wheel).toHaveLength(2);
  expect(settledAtMs - startedAtMs).toBeLessThan(100);

  const frame = page.getByTestId("workspace-web-frame");
  const mutations = await frame.evaluate(async (element) => {
    let count = 0;
    const observer = new MutationObserver(() => {
      count += 1;
    });
    observer.observe(element, {
      attributeFilter: ["data-frame-scroll-y"],
    });
    await window.__BUZZ_E2E_WEB_PERFORMANCE__?.emitFrameBurst(12);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    observer.disconnect();
    return count;
  });
  await expect(frame).toHaveAttribute("data-frame-scroll-y", "12");
  expect(mutations).toBeLessThanOrEqual(1);
});
```

The exact command-count assertion may accept one or two calls if engine delivery places the burst on one animation-frame boundary; it must never accept more than two.

- [ ] **Step 4: Build once and capture the genuine RED**

Run:

```bash
pnpm -C desktop build:e2e
/usr/bin/time -p pnpm -C desktop exec playwright test \
  tests/e2e/workspace-web-input.spec.ts \
  --project=engine-chromium --project=engine-webkit \
  -g "bounds burst wheel latency" --reporter=list
```

Expected on unmodified product code: FAIL because twelve native wheel calls take about 300 ms under the serialized 25 ms delay; the command-count and 100 ms assertions reject that behavior. Record per-engine command count and elapsed milliseconds.

- [ ] **Step 5: Commit and push the RED proof**

```bash
git add desktop/src/testing/webE2eBridge.ts \
  desktop/tests/e2e/workspace-web-input.spec.ts \
  desktop/src/features/workspace/kinds/webKind.tsx
git commit -s -m "test(workspace): expose web scroll backpressure"
git push
```

### Task 2: Coalesce wheel input at the native boundary

**Files:**
- Modify: `desktop/src/features/workspace/lib/webSessions.ts`
- Modify: `desktop/src/features/workspace/lib/webSessions.test.mjs`

- [ ] **Step 1: Add deterministic unit coverage for delta preservation**

Stub `requestAnimationFrame` so twelve calls occupy one frame, keep the first native invocation pending, and assert:

```js
assert.equal(wheelInvocations.length, 1);
assert.deepEqual(wheelInvocations[0].input, {
  x: 23,
  y: 42,
  deltaX: 36,
  deltaY: 288,
});
```

Then queue another four ticks while the first invocation is pending, resolve it, run the next animation frame, and assert there is exactly one second aggregate.

- [ ] **Step 2: Implement a per-tab dispatcher**

Add focused internal types and state:

```ts
type WebWheelInput = {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};

type PendingWheel = {
  input: WebWheelInput;
  resolve: Array<() => void>;
  reject: Array<(cause: unknown) => void>;
};

type WheelDispatcher = {
  inFlight: boolean;
  pending: PendingWheel | null;
  scheduled: boolean;
};

const wheelDispatchers = new Map<string, WheelDispatcher>();
```

`sendWebWheel` merges deltas and latest coordinates into `pending`, schedules one animation-frame flush, and returns a promise resolved or rejected with the batch that contains that input. The flush captures the current pending aggregate, allows only one invocation, and schedules the next pending aggregate after completion.

- [ ] **Step 3: Fence lifecycle boundaries**

Add `clearWheelDispatcher(tabId)` and `clearWheelDispatchers()` calls to disposal and reset. Scheduled callbacks compare their captured dispatcher object with the current map entry before dispatching.

- [ ] **Step 4: Run the focused unit and engine regression**

Run:

```bash
node --test --experimental-strip-types \
  desktop/src/features/workspace/lib/webSessions.test.mjs
/usr/bin/time -p pnpm -C desktop build:e2e
/usr/bin/time -p pnpm -C desktop exec playwright test \
  tests/e2e/workspace-web-input.spec.ts \
  --project=engine-chromium --project=engine-webkit \
  -g "bounds burst wheel latency" --reporter=list
```

Expected: unit tests pass; the engine probe preserves 288 vertical and 36 horizontal delta, issues at most two wheel commands, and settles below 100 ms in each engine. The frame mutation assertion may remain red until Task 3.

- [ ] **Step 5: Commit and push wheel coalescing**

```bash
git add desktop/src/features/workspace/lib/webSessions.ts \
  desktop/src/features/workspace/lib/webSessions.test.mjs
git commit -s -m "fix(workspace): coalesce web wheel input"
git push
```

### Task 3: Publish only the newest frame per animation frame

**Files:**
- Modify: `desktop/src/features/workspace/lib/webSessions.ts`
- Modify: `desktop/src/features/workspace/lib/webSessions.test.mjs`

- [ ] **Step 1: Add a deterministic stale-frame unit test**

Emit twelve frames for the same native session before running the fake animation-frame callback. Assert the subscribed session listener fires once, the final `scrollOffsetY` is `12`, and no frame is published after disposal/reset.

- [ ] **Step 2: Add the latest-frame queue**

Add:

```ts
const queuedFrames = new Map<string, WebFrame>();
let frameFlushScheduled = false;
```

The native frame listener stores the latest frame by native session ID and schedules one animation-frame flush. The flush clears its scheduled flag, takes the queued entries, verifies `nativeToTab` still owns each session, and calls `setSession` once with the newest frame.

- [ ] **Step 3: Clear stale frames at every close boundary**

Delete queued frames on `workspace-web-closed`, `disposeWebSession`, and `resetWebSessions`. A scheduled callback must safely no-op after those maps are cleared.

- [ ] **Step 4: Rebuild and make the complete engine probe green**

Run:

```bash
node --test --experimental-strip-types \
  desktop/src/features/workspace/lib/webSessions.test.mjs
/usr/bin/time -p pnpm -C desktop build:e2e
/usr/bin/time -p pnpm -C desktop exec playwright test \
  tests/e2e/workspace-web-input.spec.ts \
  --project=engine-chromium --project=engine-webkit \
  --reporter=list
```

Expected: all Web session units pass; all engine input tests pass; the burst probe records at most one frame mutation and a final scroll offset of 12. Record the focused command wall time and per-engine before/after latency.

- [ ] **Step 5: Commit and push latest-frame delivery**

```bash
git add desktop/src/features/workspace/lib/webSessions.ts \
  desktop/src/features/workspace/lib/webSessions.test.mjs
git commit -s -m "fix(workspace): drop stale web frames"
git push
```

### Task 4: Validate current develop integration and open the PR

**Files:**
- Verify: all files changed by Tasks 1-3
- Verify: `desktop/native-inventory.json`

- [ ] **Step 1: Confirm the branch is still based on current develop**

```bash
git fetch origin develop
git merge-base --is-ancestor origin/develop HEAD
```

Expected: exit 0. If develop advanced, merge `origin/develop`, rebuild, and rerun the focused engine and session tests before continuing.

- [ ] **Step 2: Run focused frontend gates**

```bash
pnpm -C desktop typecheck
pnpm -C desktop check
pnpm -C desktop check:file-sizes
pnpm -C desktop check:native-inventory
node --test --experimental-strip-types \
  desktop/src/features/workspace/lib/webSessions.test.mjs
```

Expected: all pass without generated inventory drift.

- [ ] **Step 3: Run focused Rust Web gates**

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml web::tests
cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  --test web_lifecycle_tests -- --ignored --test-threads=1
```

Expected: Web command/session units and real lifecycle probes pass; no browser/profile residue remains.

- [ ] **Step 4: Run formatting and diff gates**

```bash
just desktop-fmt-check
just desktop-tauri-fmt-check
git diff --check origin/develop...HEAD
git status --short
```

Expected: clean working tree and no formatting or whitespace failures.

- [ ] **Step 5: Open the develop-targeted PR and arm auto-merge**

The PR body must state the clean-develop RED measurements, final per-engine latency, command count, frame mutation count, test iteration time, and that the browser remains preview-only.

```bash
gh pr create --repo AI-Native-Ventures/Colony \
  --base develop \
  --head fix/workspace-web-scroll-performance \
  --title "fix(workspace): make preview web scrolling responsive" \
  --body-file /tmp/workspace-web-scroll-pr.md
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
git ls-remote --heads origin fix/workspace-web-scroll-performance
```

Expected: the remote branch SHA matches local HEAD, the PR targets `develop`, and auto-merge is armed without bypassing any red or pending check.
