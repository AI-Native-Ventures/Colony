# Workspace Focus Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an open workspace into a clean focus layout with a 20% thread context pane, an 80% workspace, one-click web navigation, and exact restoration of the prior conversation layout.

**Architecture:** Treat `ChannelSurfaceMode === "workspace"` as the single focus-mode source of truth and remove the parallel expanded state. Keep conversation surfaces mounted but hidden and inert, preserve the user's ordinary sidebar preference outside focus mode, and give the focus split its own session-scoped ratio. Reuse or create Web tabs by canonical URL and let a link-created tab start its native browser session automatically.

**Tech Stack:** React 19, TypeScript, localStorage and sessionStorage UI state, Tauri native browser sessions, Node test runner, Playwright

---

## File map

- Modify `desktop/src/features/workspace/lib/channelSurfaceMode.ts`: retain only timeline and workspace modes.
- Modify `desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs`: prove the simplified state contract.
- Replace `desktop/src/features/workspace/ui/useWorkspacePanelWidth.ts` with `desktop/src/features/workspace/ui/useWorkspaceFocusSplit.ts`: own the dedicated 20/80 ratio.
- Create `desktop/src/features/workspace/ui/useWorkspaceFocusSplit.test.mjs`: prove ratio and minimum-width math.
- Modify `desktop/src/features/workspace/ui/ChannelWorkspaceDock.tsx`: render the focus workspace and shared divider from parent-owned split values.
- Modify `desktop/src/features/workspace/ui/RightWorkspacePane.tsx`: remove fullscreen overlay behavior.
- Create `desktop/src/features/workspace/ui/WorkspaceFocusThreadPane.tsx`: size the retained thread without a competing resize handle.
- Modify `desktop/src/features/channels/ui/ChannelPane.tsx`: hide and inert the channel, retain only a real thread, and keep state mounted.
- Modify `desktop/src/app/AppShell.tsx`: hide the sidebar and community rail without overwriting the normal sidebar preference.
- Modify `desktop/src/features/sidebar/ui/AppSidebar.tsx`: remove workspace-expanded coupling.
- Modify `desktop/src/app/RelayConnectionOverlay.tsx`: use effective community-rail visibility.
- Modify `desktop/src/features/messages/ui/MessageThreadPanel.tsx`: show channel and root context in focus mode.
- Modify `desktop/src/features/messages/ui/MessageThreadPanel.helpers.ts`: summarize the root message safely.
- Modify `desktop/src/features/messages/ui/MessageThreadPanel.helpers.test.mjs`: prove root summaries.
- Modify `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`: expose Back to conversation and close the last tab cleanly.
- Modify `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx`: replace maximize controls with a labeled exit action.
- Modify `desktop/src/features/workspace/lib/openUrlInWorkspace.ts`: canonical-URL reuse in the current channel.
- Modify `desktop/src/features/workspace/lib/openUrlInWorkspace.test.mjs`: prove deduplication and channel isolation.
- Modify `desktop/src/features/workspace/kinds/webKind.tsx`: auto-start link-created tabs and render retryable status.
- Modify `desktop/src/features/workspace/lib/webSessions.test.mjs`: retain the one-start concurrency proof.
- Modify `desktop/tests/e2e/channel-workspace.spec.ts`: prove geometry, hiding, restoration, and URL reuse.

### Task 1: Make workspace mode the only focus-mode state

**Files:**
- Modify: `desktop/src/features/workspace/lib/channelSurfaceMode.ts`
- Modify: `desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs`
- Modify: all imports returned by `rg -n "WorkspaceExpanded|workspaceExpanded" desktop/src`

- [ ] **Step 1: Rewrite the state tests to require one source of truth**

Remove expanded-state assertions and keep this contract:

```js
test("workspace mode is channel-scoped and resettable", () => {
  setChannelSurfaceMode("alpha", "workspace");
  assert.equal(getChannelSurfaceMode("alpha"), "workspace");
  assert.equal(getChannelSurfaceMode("beta"), "timeline");

  resetChannelSurfaceModes();
  assert.equal(getChannelSurfaceMode("alpha"), "timeline");
});
```

- [ ] **Step 2: Run the full desktop unit suite and confirm callers still fail**

Run: `cd desktop && pnpm test`

Expected: the rewritten state test passes, while later compilation will still find `useWorkspaceExpanded` callers until they are removed in this task.

- [ ] **Step 3: Remove the expanded record and API**

Keep `channelSurfaceMode.ts` limited to:

```ts
export type ChannelSurfaceMode = "timeline" | "workspace";

const MODE_STORAGE_KEY = "buzz.channels.surfaceMode";
const DEFAULT_MODE: ChannelSurfaceMode = "timeline";

export function resetChannelSurfaceModes(): void {
  modes = {};
  persist(MODE_STORAGE_KEY, modes);
  emit();
}
```

Delete `EXPANDED_STORAGE_KEY`, `expanded`, `parseExpanded`, `getWorkspaceExpanded`, `setWorkspaceExpanded`, and `useWorkspaceExpanded`. Remove their imports and props from current callers. Do not replace them with another focus boolean.

- [ ] **Step 4: Run unit and type checks**

Run: `cd desktop && pnpm test && pnpm typecheck`

Expected: PASS and `rg -n "WorkspaceExpanded|workspaceExpanded" desktop/src` returns no matches.

- [ ] **Step 5: Commit the state simplification**

```bash
git add desktop/src/features/workspace/lib/channelSurfaceMode.ts desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs desktop/src
git commit -m "refactor(desktop): unify workspace focus state" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 2: Add the dedicated 20/80 focus split

**Files:**
- Delete: `desktop/src/features/workspace/ui/useWorkspacePanelWidth.ts`
- Create: `desktop/src/features/workspace/ui/useWorkspaceFocusSplit.ts`
- Create: `desktop/src/features/workspace/ui/useWorkspaceFocusSplit.test.mjs`

- [ ] **Step 1: Add failing split-math tests**

Create `useWorkspaceFocusSplit.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFocusThreadWidth,
  DEFAULT_FOCUS_THREAD_RATIO,
} from "./useWorkspaceFocusSplit.ts";

test("the default focus split is 20/80", () => {
  assert.equal(DEFAULT_FOCUS_THREAD_RATIO, 0.2);
  assert.equal(clampFocusThreadWidth(320, 1600), 320);
});

test("thread and workspace minimum widths are enforced", () => {
  assert.equal(clampFocusThreadWidth(100, 1200), 280);
  assert.equal(clampFocusThreadWidth(1100, 1200), 880);
});

test("narrow containers give the workspace priority after thread minimum", () => {
  assert.equal(clampFocusThreadWidth(300, 500), 180);
});
```

- [ ] **Step 2: Run the full desktop unit suite and confirm failure**

Run: `cd desktop && pnpm test`

Expected: FAIL because `useWorkspaceFocusSplit.ts` is missing.

- [ ] **Step 3: Implement the split hook**

Create `useWorkspaceFocusSplit.ts` with this public contract:

```ts
import * as React from "react";

export const DEFAULT_FOCUS_THREAD_RATIO = 0.2;
export const FOCUS_THREAD_MIN_WIDTH_PX = 280;
export const FOCUS_WORKSPACE_MIN_WIDTH_PX = 320;
const SESSION_KEY = "buzz.desktop.workspace-focus-thread-ratio";

export function clampFocusThreadWidth(
  requestedWidth: number,
  containerWidth: number,
): number {
  if (containerWidth <= 0) return FOCUS_THREAD_MIN_WIDTH_PX;
  const maximum = Math.max(0, containerWidth - FOCUS_WORKSPACE_MIN_WIDTH_PX);
  const minimum = Math.min(FOCUS_THREAD_MIN_WIDTH_PX, maximum);
  return Math.max(minimum, Math.min(maximum, requestedWidth));
}

function readRatio(): number {
  try {
    const value = Number.parseFloat(window.sessionStorage.getItem(SESSION_KEY) ?? "");
    return Number.isFinite(value) && value > 0 && value < 1
      ? value
      : DEFAULT_FOCUS_THREAD_RATIO;
  } catch {
    return DEFAULT_FOCUS_THREAD_RATIO;
  }
}

export function useWorkspaceFocusSplit(
  containerRef: React.RefObject<HTMLElement | null>,
  hasThread: boolean,
) {
  const [preferredRatio, setPreferredRatio] = React.useState(readRatio);
  const [containerWidth, setContainerWidth] = React.useState(0);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setContainerWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  React.useEffect(() => {
    try {
      window.sessionStorage.setItem(SESSION_KEY, String(preferredRatio));
    } catch {
      // Keep the in-memory session preference.
    }
  }, [preferredRatio]);

  const threadWidthPx = hasThread
    ? clampFocusThreadWidth(containerWidth * preferredRatio, containerWidth)
    : 0;

  const onResizeStart = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const move = (moveEvent: PointerEvent) => {
        const width = clampFocusThreadWidth(moveEvent.clientX - bounds.left, bounds.width);
        setPreferredRatio(width / bounds.width);
      };
      const stop = () => window.removeEventListener("pointermove", move);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    },
    [containerRef],
  );

  return {
    canReset: preferredRatio !== DEFAULT_FOCUS_THREAD_RATIO,
    onReset: () => setPreferredRatio(DEFAULT_FOCUS_THREAD_RATIO),
    onResizeStart,
    threadWidthPx,
    workspaceWidthPx: hasThread ? Math.max(0, containerWidth - threadWidthPx) : containerWidth,
  };
}
```

- [ ] **Step 4: Run the full desktop unit suite**

Run: `cd desktop && pnpm test`

Expected: PASS.

- [ ] **Step 5: Commit split-state math**

```bash
git add desktop/src/features/workspace/ui/useWorkspacePanelWidth.ts desktop/src/features/workspace/ui/useWorkspaceFocusSplit.ts desktop/src/features/workspace/ui/useWorkspaceFocusSplit.test.mjs
git commit -m "feat(desktop): add workspace focus split" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 3: Compose the thread and workspace focus layout

**Files:**
- Create: `desktop/src/features/workspace/ui/WorkspaceFocusThreadPane.tsx`
- Modify: `desktop/src/features/workspace/ui/ChannelWorkspaceDock.tsx`
- Modify: `desktop/src/features/workspace/ui/RightWorkspacePane.tsx`
- Modify: `desktop/src/features/channels/ui/ChannelPane.tsx`

- [ ] **Step 1: Add failing geometry assertions to the workspace E2E spec**

In `desktop/tests/e2e/channel-workspace.spec.ts`, replace the old three-pane and expanded cases with assertions that opening the workspace while a thread is open hides `channel-drop-zone`, keeps `message-thread-panel` visible, and measures the thread at 20% plus or minus 16px of `channel-workspace-pane` plus thread width. Add a second case that closes the thread before opening the workspace and expects the workspace to occupy the full content width.

- [ ] **Step 2: Build and run the focused browser spec to confirm failure**

Run: `cd desktop && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: FAIL because the channel remains visible and the workspace still uses the old right-dock width.

- [ ] **Step 3: Create the focus thread wrapper**

Create `WorkspaceFocusThreadPane.tsx`:

```tsx
import type * as React from "react";

type WorkspaceFocusThreadPaneProps = {
  children: React.ReactNode;
  widthPx: number;
};

export function WorkspaceFocusThreadPane({
  children,
  widthPx,
}: WorkspaceFocusThreadPaneProps): React.JSX.Element {
  return (
    <aside
      aria-label="Thread context"
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-background"
      data-testid="workspace-focus-thread-pane"
      style={{ width: widthPx }}
    >
      {children}
    </aside>
  );
}
```

- [ ] **Step 4: Make the workspace pane a focus sibling**

Change `RightWorkspacePane` to accept `hasThread`, `widthPx`, and divider callbacks. When `hasThread` is false, render width `100%` and no divider. When true, render the shared left divider and the supplied pixel width. Remove all `absolute`, `expanded`, maximize, and overlay branches.

Use this outer element:

```tsx
<aside
  aria-label="Channel workspace"
  className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-background before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-40 before:w-px before:bg-border/80 before:content-['']"
  data-testid="channel-workspace-pane"
  style={{ width: hasThread ? widthPx : "100%" }}
>
  {hasThread ? (
    <button
      aria-label="Resize workspace"
      className="group/workspace-resize absolute inset-y-0 left-0 z-50 w-3 -translate-x-1/2 cursor-col-resize"
      data-testid="workspace-pane-resize-handle"
      onDoubleClick={canResetWidth ? onResetWidth : undefined}
      onPointerDown={onResizeStart}
      type="button"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover/workspace-resize:bg-border/80 group-focus-visible/workspace-resize:bg-border/80" />
    </button>
  ) : null}
  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
</aside>
```

- [ ] **Step 5: Wire ChannelPane and the dock to one split owner**

Call `useWorkspaceFocusSplit(layoutRef, hasWorkspaceThread)` once in `ChannelPane`, because that component owns both siblings. Use `threadWidthPx` for `WorkspaceFocusThreadPane`. Change `ChannelWorkspaceDock` props to `channelId`, `hasThread`, `workspaceWidthPx`, `canResetWidth`, `onResetWidth`, and `onResizeStart`; pass those values to `RightWorkspacePane`. Return null unless the channel surface is `workspace`.

- [ ] **Step 6: Hide conversation surfaces but keep them mounted**

In `ChannelPane.tsx`, derive:

```ts
const workspaceOpen = useChannelSurfaceMode(activeChannel?.id) === "workspace";
const hasWorkspaceThread = Boolean(threadHeadMessage) || shouldShowThreadSkeleton;
```

Set the channel section to `hidden={workspaceOpen}` and `inert={workspaceOpen || channelIsCovered ? true : undefined}`. When `workspaceOpen`, do not render channel management, agent session, or profile auxiliary panels. Wrap the real thread or thread skeleton in `WorkspaceFocusThreadPane` with `threadWidthPx` from the shared focus split. Keep the normal auxiliary wrapper and its normal width for timeline mode.

Pass the same split result and `hasThread={hasWorkspaceThread}` to `ChannelWorkspaceDock`. Preserve the thread node key so drafts, scroll anchors, and composer state do not remount when the surface changes.

- [ ] **Step 7: Run desktop checks and the focused browser spec**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: PASS with 20/80, draggable reset, and 100% no-thread assertions.

- [ ] **Step 8: Commit the focus composition**

```bash
git add desktop/src/features/workspace/ui/WorkspaceFocusThreadPane.tsx desktop/src/features/workspace/ui/ChannelWorkspaceDock.tsx desktop/src/features/workspace/ui/RightWorkspacePane.tsx desktop/src/features/channels/ui/ChannelPane.tsx desktop/tests/e2e/channel-workspace.spec.ts
git commit -m "feat(desktop): compose workspace focus mode" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 4: Hide all navigation chrome without losing its preference

**Files:**
- Modify: `desktop/src/app/AppShell.tsx`
- Modify: `desktop/src/features/sidebar/ui/AppSidebar.tsx`
- Modify: `desktop/src/app/RelayConnectionOverlay.tsx`
- Modify: `desktop/tests/e2e/channel-workspace.spec.ts`

- [ ] **Step 1: Add failing sidebar and community-rail assertions**

Add Playwright cases for both paths:

```ts
await expect(page.getByTestId("app-sidebar")).toBeHidden();
await expect(page.getByTestId("community-rail")).toBeHidden();
await expect(page.getByTestId("app-top-chrome")).toBeVisible();
```

One case collapses the ordinary sidebar. The other starts with the sidebar expanded, enters workspace focus, exits, and expects both sidebar and rail to return to their exact prior visibility.

- [ ] **Step 2: Build and run the focused browser spec to confirm failure**

Run: `cd desktop && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: FAIL because the community rail is outside the sidebar visibility state.

- [ ] **Step 3: Control effective sidebar visibility in AppShell**

Replace the expanded-state read with:

```ts
const workspaceOpen =
  useChannelSurfaceMode(activeChannel?.id) === "workspace";
const [sidebarOpen, setSidebarOpen] = React.useState(true);
const effectiveSidebarOpen = sidebarOpen && !workspaceOpen;
const effectiveCommunityRail =
  hasCommunityRail && effectiveSidebarOpen && !isHuddleRoom;
```

Control the provider without mutating the saved preference during focus:

```tsx
<SidebarProvider
  className="relative z-10 min-h-0 flex-1 flex-col overflow-visible"
  data-testid="app-sidebar-layer"
  onOpenChange={(nextOpen) => {
    if (!workspaceOpen) setSidebarOpen(nextOpen);
  }}
  open={effectiveSidebarOpen}
>
```

Render `CommunityRail` only when `effectiveCommunityRail` is true. Pass the same effective value to `AppTopChrome` and `RelayConnectionOverlay` so their offsets match visible chrome. Keep `AppTopChrome` mounted in focus mode so its sidebar trigger and navigation controls remain available.

- [ ] **Step 4: Remove workspace coupling from AppSidebar**

Delete the `workspaceExpanded` prop and remove only its `hidden` attribute from the existing root. Keep the current click handler, classes, variant, and children unchanged:

```tsx
<Sidebar
  className="!z-[100] !border-r-0"
  collapsible="offcanvas"
  data-testid="app-sidebar"
  onClick={(event) => {
    if (isSidebarBackgroundTarget(event.target)) {
      onBackgroundClick?.();
    }
  }}
  variant="sidebar"
>
```

- [ ] **Step 5: Run the desktop package checks and focused browser spec**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: PASS. Ordinary collapse and workspace focus both hide the sidebar and community rail, and focus exit restores the prior preference.

- [ ] **Step 6: Commit navigation visibility**

```bash
git add desktop/src/app/AppShell.tsx desktop/src/features/sidebar/ui/AppSidebar.tsx desktop/src/app/RelayConnectionOverlay.tsx desktop/tests/e2e/channel-workspace.spec.ts
git commit -m "fix(desktop): hide navigation in workspace focus" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 5: Add thread orientation and a clear exit

**Files:**
- Modify: `desktop/src/features/messages/ui/MessageThreadPanel.helpers.ts`
- Modify: `desktop/src/features/messages/ui/MessageThreadPanel.helpers.test.mjs`
- Modify: `desktop/src/features/messages/ui/MessageThreadPanel.tsx`
- Modify: `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx`
- Modify: `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`

- [ ] **Step 1: Add failing root-summary tests**

Add:

```js
test("summarizeThreadRoot collapses whitespace and truncates safely", () => {
  assert.equal(summarizeThreadRoot("  First\n\nreply  "), "First reply");
  assert.equal(
    summarizeThreadRoot("a".repeat(90)),
    `${"a".repeat(77)}...`,
  );
});
```

- [ ] **Step 2: Run the full desktop unit suite and confirm failure**

Run: `cd desktop && pnpm test`

Expected: FAIL because `summarizeThreadRoot` is missing.

- [ ] **Step 3: Implement and render focus context**

Add to `MessageThreadPanel.helpers.ts`:

```ts
export function summarizeThreadRoot(body: string, maximum = 80): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 3)).trimEnd()}...`;
}
```

Add `showWorkspaceContext?: boolean` to `MessageThreadPanelProps`. In focus mode render the header title group as:

```tsx
<div className="min-w-0">
  <AuxiliaryPanelTitle>
    {showWorkspaceContext ? `#${channelName}` : "Thread"}
  </AuxiliaryPanelTitle>
  {showWorkspaceContext ? (
    <p className="truncate text-xs text-muted-foreground" title={threadHead.body}>
      {summarizeThreadRoot(threadHead.body)}
    </p>
  ) : null}
</div>
```

Pass `showWorkspaceContext={workspaceOpen}` from `ChannelPane`.

- [ ] **Step 4: Replace the maximize toggle with Back to conversation**

Change `WorkspaceTabStripProps` to include `onBackToConversation` and remove `isExpanded` and `onToggleExpanded`. Render:

```tsx
<button
  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-background/60"
  data-testid="workspace-back-to-conversation"
  onClick={onBackToConversation}
  type="button"
>
  Back to conversation
</button>
```

In `ChannelWorkspace`, pass `onBackToConversation={() => setChannelSurfaceMode(channelId, "timeline")}`. When the last tab closes, set only the surface mode to timeline. Do not clear tabs, drafts, or browser sessions during the mode switch.

- [ ] **Step 5: Run desktop checks**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check`

Expected: PASS.

- [ ] **Step 6: Commit orientation and exit controls**

```bash
git add desktop/src/features/messages/ui/MessageThreadPanel.helpers.ts desktop/src/features/messages/ui/MessageThreadPanel.helpers.test.mjs desktop/src/features/messages/ui/MessageThreadPanel.tsx desktop/src/features/channels/ui/ChannelPane.tsx desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx desktop/src/features/workspace/ui/ChannelWorkspace.tsx
git commit -m "feat(desktop): orient workspace thread context" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 6: Reuse exact Web URLs inside the current channel

**Files:**
- Modify: `desktop/src/features/workspace/lib/openUrlInWorkspace.ts`
- Modify: `desktop/src/features/workspace/lib/openUrlInWorkspace.test.mjs`

- [ ] **Step 1: Add failing exact-URL reuse tests**

Add dependency spies for `getWorkspace` and `setActiveTab`, then prove:

```js
test("reuses a canonical URL in the current channel", () => {
  const result = openLinkInWorkspace(
    { channelId: "alpha", href: "https://example.com" },
    dependenciesWithTabs([
      webTab("existing", "https://example.com/"),
    ]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.tabId, "existing");
  assert.equal(result.reused, true);
  assert.deepEqual(calls.openTab, []);
  assert.deepEqual(calls.setActiveTab, [["alpha", "existing"]]);
});

test("does not reuse a tab from another channel or a different URL", () => {
  const result = openLinkInWorkspace(
    { channelId: "beta", href: "https://example.com/path" },
    dependenciesWithTabs([]),
  );
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(calls.openTab.length, 1);
});
```

- [ ] **Step 2: Run the full desktop unit suite and confirm failure**

Run: `cd desktop && pnpm test`

Expected: FAIL because the function always opens a new tab and has no `reused` result.

- [ ] **Step 3: Add canonical current-channel deduplication**

Extend dependencies with `getWorkspace` and `setActiveTab`. Add:

```ts
function webTabUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).url;
  return typeof value === "string" ? parseWorkspaceUrl(value)?.href ?? null : null;
}
```

Before `openTab`, reuse only an exact canonical URL in `getWorkspace(channelId).tabs`:

```ts
const existing = dependencies
  .getWorkspace(channelId)
  .tabs.find(
    (tab) => tab.kind === "web" && webTabUrl(tab.payload) === decision.url,
  );
if (existing) {
  dependencies.setActiveTab(channelId, existing.id);
  dependencies.setSurfaceMode(channelId, "workspace");
  return {
    ok: true,
    reused: true,
    tabId: existing.id,
    title: existing.title,
    url: decision.url,
  };
}
```

Return `reused: false` on the new-tab path. Keep URL canonicalization in `parseWorkspaceUrl`, so `https://example.com` and `https://example.com/` match while query or hash differences remain distinct.

- [ ] **Step 4: Run the full desktop unit suite**

Run: `cd desktop && pnpm test`

Expected: PASS.

- [ ] **Step 5: Commit Web tab reuse**

```bash
git add desktop/src/features/workspace/lib/openUrlInWorkspace.ts desktop/src/features/workspace/lib/openUrlInWorkspace.test.mjs
git commit -m "feat(desktop): reuse exact workspace URLs" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 7: Start link-created browser sessions immediately

**Files:**
- Modify: `desktop/src/features/workspace/kinds/webKind.tsx`
- Modify: `desktop/src/features/workspace/lib/webSessions.test.mjs`
- Modify: `desktop/tests/e2e/channel-workspace.spec.ts`

- [ ] **Step 1: Add failing Playwright expectations**

Click a supported message link and assert, without clicking Connect:

```ts
await expect(page.getByTestId("workspace-web-body")).toHaveAttribute(
  "data-status",
  /connecting|running/,
);
await expect(page.getByTestId("workspace-web-connect")).not.toBeFocused();
```

Click the same link twice and assert one matching Web tab exists. Force the mocked native start to fail once, expect `workspace-web-error` and a Retry button, click Retry, then expect `data-status="running"`.

- [ ] **Step 2: Build and run the focused browser spec to confirm failure**

Run: `cd desktop && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: FAIL because link-created tabs wait for the Connect button.

- [ ] **Step 3: Auto-start only nonblank link-created tabs**

In `WebBody`, add:

```tsx
const autoStartKey = React.useRef<string | null>(null);

React.useEffect(() => {
  const requestedUrl = payload.url.trim();
  if (!requestedUrl || requestedUrl === "about:blank") return;
  const key = `${payload.endpoint ?? ""}|${payload.targetId ?? ""}|${requestedUrl}`;
  if (autoStartKey.current === key) return;
  autoStartKey.current = key;
  void ensureWebSession(tab.id, {
    endpoint: payload.endpoint,
    targetId: payload.targetId,
    url: requestedUrl,
  });
}, [payload.endpoint, payload.targetId, payload.url, tab.id]);
```

This preserves manual setup for a newly created `about:blank` Web tab. Existing `ensureWebSession` start guards prevent duplicate native sessions.

- [ ] **Step 4: Contain loading, failure, and retry in the Web tab**

Inside the browser surface, show a loading state when `session.status === "connecting" && !session.frame`. Replace the error banner with:

```tsx
{session.error ? (
  <div className="flex items-center justify-between gap-3 border-b border-destructive/30 px-3 py-2 text-sm" data-testid="workspace-web-error">
    <span className="text-destructive">{session.error}</span>
    <button className="rounded-md border border-border px-2 py-1 text-foreground" onClick={connect} type="button">
      Retry
    </button>
  </div>
) : null}
```

The Retry button calls the same `connect` callback as the advanced controls and never exits workspace focus.

- [ ] **Step 5: Run unit and browser suites**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check && pnpm build:e2e && pnpm exec playwright test tests/e2e/channel-workspace.spec.ts`

Expected: PASS, including the existing concurrency test that one tab receives one native start.

- [ ] **Step 6: Commit one-click web navigation**

```bash
git add desktop/src/features/workspace/kinds/webKind.tsx desktop/src/features/workspace/lib/webSessions.test.mjs desktop/tests/e2e/channel-workspace.spec.ts
git commit -m "feat(desktop): open links in live workspace tabs" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 8: Prove restoration and desktop-width behavior

**Files:**
- Modify: `desktop/tests/e2e/channel-workspace.spec.ts`

- [ ] **Step 1: Add the full restoration scenario**

At 1600x900, open a thread, type unsent drafts in the channel and thread composers, record both scroll positions, collapse the sidebar, open two workspace tabs, resize away from 20/80, and activate the first tab. Exit with Back to conversation, then re-enter focus.

Expected assertions:

```ts
await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
await expect(page.getByTestId("message-thread-panel")).toBeVisible();
await expect(page.getByTestId("message-composer")).toContainText(channelDraft);
await expect(page.getByTestId("thread-message-composer")).toContainText(threadDraft);
await expect(page.getByTestId("app-sidebar")).toBeHidden();
await expect(page.getByTestId(activeWorkspaceTabId)).toHaveAttribute("aria-selected", "true");
```

Assert scroll positions with `expect.poll`, allowing a two-pixel browser rounding tolerance.

- [ ] **Step 2: Add narrow desktop geometry**

At both 1280x720 and 1024x768, enter focus with a thread and assert thread width is at least 280px, workspace width is at least 320px, and the composer, Back to conversation, tab close, URL field, and divider are all visible and not overlapping.

- [ ] **Step 3: Run the full desktop proof gate**

Run: `cd desktop && pnpm test && pnpm typecheck && pnpm check && pnpm build:e2e && pnpm exec playwright test`

Expected: every desktop unit test, static check, and Playwright project PASS.

- [ ] **Step 4: Capture exact-commit visual proof**

Run: `git rev-parse HEAD`

Capture screenshots at 1600x900 and 1024x768 for the thread plus workspace state and the 100% no-thread state. Record the exact commit alongside screenshots. Check for clipped composer controls, hidden close actions, unexpected horizontal scrolling, or content under the divider.

- [ ] **Step 5: Commit the final browser proof**

```bash
git add desktop/tests/e2e/channel-workspace.spec.ts
git commit -m "test: prove workspace focus restoration" \
  --trailer "Co-authored-by: Basheer Phiri <phiribash@gmail.com>" \
  --trailer "Signed-off-by: Basheer Phiri <phiribash@gmail.com>"
```

### Task 9: Prove the packaged Tauri boundary

**Files:**
- No source changes expected.

- [ ] **Step 1: Build and install the packaged desktop application**

Use the repository's documented production-equivalent Tauri packaging command and install that exact local artifact. Record `git rev-parse HEAD` and the application build identifier before testing.

- [ ] **Step 2: Drive the real one-click URL path**

From a real channel thread, click an HTTP(S) message link once.

Expected: the native browser session starts immediately, the page becomes visible without Connect or Open site, the thread occupies the left focus pane, and the sidebar and channel are hidden.

- [ ] **Step 3: Drive focus restoration**

Resize the divider, navigate within the native browser, type an unsent thread draft, exit focus, and re-enter.

Expected: the normal sidebar preference, channel, thread draft, scroll position, selected tab, native browser page, and focus split preference are preserved. With no thread open, the workspace occupies 100%.

- [ ] **Step 4: Record the live-adoption boundary**

Do not call the change deployed or live based on the local package. After merge, require green CI on a head rebased onto current `origin/develop`. After a release is explicitly authorized and published, repeat the real link and document flows in the released app before reporting live proof.
