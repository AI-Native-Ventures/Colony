# Workspace Web Scroll Performance Design

## Goal

Make trackpad and mouse-wheel scrolling in the preview Web workspace tab feel responsive without replacing its CDP screencast architecture or expanding the release scope. The browser remains a default-off preview feature.

## Current behavior

The visible Web surface is a React image fed by `Page.startScreencast`. Every raw wheel event currently starts its own Tauri invocation, the Rust session serializes those invocations into CDP commands, and every received frame immediately updates the external React store. A trackpad burst therefore creates both an input backlog and repeated image decodes for frames that are already stale by the time they render.

The existing Chromium/WebKit tests prove that wheel input reaches the mock native bridge. They do not apply native-style serialization delay, measure burst completion, assert delta preservation, or observe frame-render churn.

## Chosen design

### Wheel coalescing

Add a small per-tab wheel dispatcher at the `webSessions.ts` native boundary.

- Aggregate `deltaX` and `deltaY` received during the same animation-frame window.
- Use the newest pointer coordinates for the aggregate.
- Allow at most one `workspace_web_wheel` invocation in flight per tab.
- While that invocation is pending, retain one pending aggregate rather than enqueueing individual ticks.
- After completion, flush the pending aggregate on the next animation frame.
- Preserve the sum of all deltas; coalescing changes command count, not scroll distance.
- Clear dispatcher state when a tab is disposed or all Web sessions are reset so an old gesture cannot cross a lifecycle boundary.

`sendWebWheel` remains the public entry point. Callers do not acquire queue ownership or CDP knowledge.

### Latest-frame delivery

Coalesce native `workspace-web-frame` events before they update the React session store.

- Retain only the newest uncommitted frame for each native session.
- Schedule at most one store flush per animation frame.
- On flush, verify that the native session is still mapped to the same tab before publishing the frame.
- Clear queued frames on close, disposal, and community reset.
- Use a microtask fallback only in non-browser unit-test environments where `requestAnimationFrame` is unavailable.

This deliberately drops stale frames at the frontend delivery boundary. It avoids repeated React notifications and image decodes without changing CDP screencast acknowledgement semantics in Rust.

## Proof design

Extend the focused Web E2E bridge with two deterministic controls used only by the existing engine-parity spec:

1. A serialized wheel delay that models the production one-command-at-a-time native path.
2. A rapid frame-burst emitter with distinguishable frame payloads.

The Chromium and WebKit regression uses real `page.mouse.wheel` input and a 25 ms serialized bridge delay. For a 12-tick burst it must prove:

- the complete horizontal and vertical delta sums reach the bridge;
- no more than one native wheel invocation is pending at any moment;
- the full delta sum is preserved regardless of engine driver pacing;
- the final aggregate settles within 100 ms of the last delivered input;
- a rapid stale-frame burst produces only the newest visible frame and at most one image-source commit per animation frame.

The regression must fail on unmodified `develop` and pass after the product change. It runs with:

```bash
pnpm -C desktop exec playwright test tests/e2e/workspace-web-input.spec.ts \
  --project=engine-chromium --project=engine-webkit --reporter=list
```

Baseline measurements on clean `develop`:

- `pnpm -C desktop build:e2e`: 29.15 seconds, including first-worktree dependency linking.
- The existing 10-test Chromium/WebKit input suite: 29.12 seconds.

The changed focused iteration must remain below 60 seconds. Packaged Tauri rebuilds are outside this loop.

## Error and lifecycle behavior

- A failed wheel invocation must not deadlock the dispatcher; it releases the in-flight slot and continues with the newest pending aggregate.
- The existing fire-and-forget UI behavior remains: transport errors follow the current native error/session handling rather than surfacing a new toast per wheel tick.
- Disposal and reset invalidate queued work before native close commands complete.
- Frame coalescing never changes session status, URL, ownership, or browser-process cleanup.

## Scope boundaries

Included:

- frontend wheel-command coalescing;
- frontend latest-frame delivery;
- deterministic mock-native delay/frame controls;
- Chromium and WebKit burst regression;
- focused frontend checks and existing Rust Web lifecycle regression runs.

Excluded:

- replacing CDP with a native webview;
- changing packaged Flow 08;
- changing browser lifecycle or process cleanup;
- changing screencast quality, dimensions, or acknowledgement behavior;
- enabling the preview feature by default;
- cookie import.

## Acceptance gate

The change is ready for a develop-targeted PR when all of the following are true:

1. The new engine regression is captured red on clean `develop` and green on the fix in Chromium and WebKit.
2. The focused two-engine loop is below 60 seconds.
3. The 12-tick gesture preserves total delta, keeps one native call pending, and settles within 100 ms of the last input in both engines. The deterministic unit probe separately proves twelve same-frame ticks collapse into one native call.
4. The frame burst commits only the newest frame without stale post-reset delivery.
5. Existing Web input, Web session unit, native Web lifecycle, formatting, type, inventory, and file-size checks pass.
6. The browser remains default-off and preview-only.
