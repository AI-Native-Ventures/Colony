# Channel Workspace Phase A Implementation Plan

> **Historical layout note:** Phase A implemented main-column replacement. That
> presentation is superseded by
> `docs/superpowers/specs/2026-08-10-channel-workspace-docked-pane-design.md`.
> Do not reuse the replacement-mode tasks for current workspace work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tabbed workspace that takes over a channel's content column in
the existing Tauri app, with a kind-agnostic tab contract proven by three
shipping kinds (`scratchpad`, `file`, `image`), so a human can open the
workspace, open tabs, and see content without any shell migration.

**Architecture:** The workspace is a *mode* of the channel content column, not a
split of it. `ChannelPane` renders either `<MessageTimeline>` (today) or
`<ChannelWorkspace>` (new) in the same slot, leaving the channel header and
`RightAuxiliaryPane` untouched. Tab state is per channel, local, and held in a
`useSyncExternalStore` module store mirroring the existing
`threadViewModePreference.ts` pattern. Tab bodies come from a kind registry: the
workspace owns the strip, lifecycle, and active-tab selection, and never reads a
tab's kind-scoped `payload`.

**Tech Stack:** React 19, TypeScript, Tailwind, Radix, `lucide-react`, Tauri 2
(one new Rust command), `node --test` for unit tests, Playwright for the E2E
screenshot spec.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-07-colony-channel-browser-workspace-design.md` (on `develop`).
- **This plan deliberately inverts the spec's v1 kind choice.** The spec ships
  `web` first. Phase A ships `scratchpad`, `file`, and `image` and defers `web`,
  because `web`'s live view is the only kind blocked by the Tauri-vs-Electron
  decision recorded in `docs/design/browser-engine-decision.md`. Every other
  rule in the spec's "Tab kinds" section is honoured verbatim.
- **One tab strip, one level of tabs.** No nested strips. A kind renders one body.
- **The tab model is not the kind model.** Tab identity, kind, title, order,
  creator, and lifecycle live on the tab. Per-kind state lives under
  `payload`, which the workspace layer must never read or branch on.
- **No `text-[13px]`-style literals.** Rem-based Tailwind tokens only
  (`text-base`, `text-sm`, `text-xs`, `text-2xs`, `text-3xs`). `pnpm check:px-text`
  fails the build otherwise. Chat body text is `text-base`.
- **Every new module-level store must be reset** in `resetCommunityState()` in
  `desktop/src/features/communities/useCommunityInit.ts`. Task 10 does this; do
  not defer it.
- **No `StatefulWidget` equivalent:** desktop uses function components only.
  No new class components.
- Hard ceiling 1000 lines per file. `ChannelPane.tsx` is already 993 lines, so
  Task 6 adds at most a handful of lines there and puts everything else in new
  files.
- Commit with `git commit -s` every time. The DCO check fails otherwise.
- Run `just ci` before opening the PR.

## Out of scope for Phase A

Named here so no task silently grows to include them:

| Deferred | Why | Lands in |
| --- | --- | --- |
| `video` kind | Needs range requests, not a one-shot read | Phase B |
| `terminal` kind | Needs a PTY subsystem and a separate engine decision | Phase C |
| `web` kind | Needs the live-view shell decision | Phase D |
| Agent ownership, grants, takeover | Needs the tab contract to exist first | Phase B |
| Approvals, evidence posting, ledger | Same | Phase B |

## File structure

| File | Responsibility |
| --- | --- |
| `desktop/src/features/workspace/lib/channelSurfaceMode.ts` | Per-channel `timeline` / `workspace` mode, persisted |
| `desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs` | Its tests |
| `desktop/src/features/workspace/lib/workspaceTabs.ts` | Kind-agnostic tab store, per channel |
| `desktop/src/features/workspace/lib/workspaceTabs.test.mjs` | Its tests |
| `desktop/src/features/workspace/lib/tabKindRegistry.ts` | Kind → definition lookup, kind-agnostic |
| `desktop/src/features/workspace/lib/tabKindRegistry.test.mjs` | Its tests, including a stub kind |
| `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx` | The one tab strip |
| `desktop/src/features/workspace/ui/ChannelWorkspace.tsx` | Workspace shell: strip + active body |
| `desktop/src/features/workspace/ui/NewTabPage.tsx` | Empty state, kind picker |
| `desktop/src/features/workspace/kinds/scratchpadKind.tsx` | `scratchpad` kind |
| `desktop/src/features/workspace/kinds/fileKind.tsx` | `file` kind |
| `desktop/src/features/workspace/kinds/imageKind.tsx` | `image` kind |
| `desktop/src-tauri/src/commands/workspace_files.rs` | `read_workspace_file` command |
| `desktop/tests/e2e/channel-workspace.spec.ts` | E2E screenshot spec |

Modified:

| File | Change |
| --- | --- |
| `desktop/src/features/channels/ui/ChannelPane.tsx:629` | Render workspace or timeline in the same slot |
| `desktop/src/features/channels/ui/ChannelScreenHeader.tsx` | Workspace toggle button |
| `desktop/src/features/communities/useCommunityInit.ts` | Reset the two new stores |
| `desktop/src-tauri/src/commands/mod.rs` | Register the new command |
| `desktop/src-tauri/src/lib.rs` | Add to the invoke handler |
| `desktop/playwright.config.ts` | Register the new spec in `smoke` |

---

## Task 1: Channel surface mode

Per-channel toggle between the message timeline and the workspace. Modelled
directly on `desktop/src/features/channels/lib/threadViewModePreference.ts`,
which is the established store pattern in this codebase: a module-level value, a
`Set` of listeners, and `React.useSyncExternalStore`.

**Files:**
- Create: `desktop/src/features/workspace/lib/channelSurfaceMode.ts`
- Test: `desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ChannelSurfaceMode = "timeline" | "workspace"`,
  `getChannelSurfaceMode(channelId: string): ChannelSurfaceMode`,
  `setChannelSurfaceMode(channelId: string, mode: ChannelSurfaceMode): void`,
  `useChannelSurfaceMode(channelId: string | undefined): ChannelSurfaceMode`,
  `getWorkspaceExpanded(channelId: string): boolean`,
  `setWorkspaceExpanded(channelId: string, expanded: boolean): void`,
  `useWorkspaceExpanded(channelId: string | undefined): boolean`,
  `resetChannelSurfaceModes(): void`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const KEY = "buzz.channels.surfaceMode";
let importSequence = 0;

async function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const module = await import(
      `./channelSurfaceMode.ts?test=${importSequence++}`
    );
    await run(module);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

test("an unknown channel starts on the timeline", async () => {
  await withStorage(memoryStorage(), (mod) => {
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
  });
});

test("mode is remembered per channel, not globally", async () => {
  await withStorage(memoryStorage(), (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "workspace");
    assert.equal(
      mod.getChannelSurfaceMode("chan-b"),
      "timeline",
      "channel b must not inherit channel a's mode",
    );
  });
});

test("mode survives a reload through localStorage", async () => {
  const storage = memoryStorage();
  await withStorage(storage, (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
  });
  await withStorage(storage, (mod) => {
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "workspace");
  });
});

test("malformed and unreadable storage falls back to timeline", async () => {
  for (const stored of ["{bad-json", "null", '{"chan-a":"nonsense"}']) {
    await withStorage(memoryStorage({ [KEY]: stored }), (mod) => {
      assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
    });
  }
  await withStorage(
    {
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("storage blocked");
      },
    },
    (mod) => {
      assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
      mod.setChannelSurfaceMode("chan-a", "workspace");
      assert.equal(
        mod.getChannelSurfaceMode("chan-a"),
        "workspace",
        "an unwritable store must still apply in memory",
      );
    },
  );
});

test("expanded state is tracked per channel and defaults false", async () => {
  await withStorage(memoryStorage(), (mod) => {
    assert.equal(mod.getWorkspaceExpanded("chan-a"), false);
    mod.setWorkspaceExpanded("chan-a", true);
    assert.equal(mod.getWorkspaceExpanded("chan-a"), true);
    assert.equal(mod.getWorkspaceExpanded("chan-b"), false);
  });
});

test("reset clears every channel back to the timeline", async () => {
  await withStorage(memoryStorage(), (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
    mod.setWorkspaceExpanded("chan-a", true);
    mod.resetChannelSurfaceModes();
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
    assert.equal(mod.getWorkspaceExpanded("chan-a"), false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/channelSurfaceMode.test.mjs`

Expected: FAIL with `Cannot find module './channelSurfaceMode.ts'`.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/workspace/lib/channelSurfaceMode.ts`:

```typescript
import * as React from "react";

/**
 * Which surface a channel's content column is showing.
 *
 * - `timeline` — the message timeline, the historical behaviour.
 * - `workspace` — the tabbed channel workspace, which takes the whole content
 *   column. The right pane is unaffected either way.
 *
 * Per channel and persisted in localStorage: leaving and returning to a channel
 * returns to the mode it was left in. This is device-level UI state rather than
 * community-scoped data, but it is keyed by channel id, so it IS cleared on
 * community switch to avoid stale ids accumulating.
 */
export type ChannelSurfaceMode = "timeline" | "workspace";

const MODE_STORAGE_KEY = "buzz.channels.surfaceMode";
const EXPANDED_STORAGE_KEY = "buzz.channels.workspaceExpanded";

const DEFAULT_MODE: ChannelSurfaceMode = "timeline";

const listeners = new Set<() => void>();

let modes = readStoredRecord(MODE_STORAGE_KEY, parseMode);
let expanded = readStoredRecord(EXPANDED_STORAGE_KEY, parseExpanded);

function parseMode(value: unknown): ChannelSurfaceMode | undefined {
  return value === "timeline" || value === "workspace" ? value : undefined;
}

function parseExpanded(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStoredRecord<T>(
  key: string,
  parse: (value: unknown) => T | undefined,
): Record<string, T> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: Record<string, T> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      const valid = parse(value);
      if (valid !== undefined) result[channelId] = valid;
    }
    return result;
  } catch {
    return {};
  }
}

function persist(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read a channel's surface mode outside of React. */
export function getChannelSurfaceMode(channelId: string): ChannelSurfaceMode {
  return modes[channelId] ?? DEFAULT_MODE;
}

/** Set a channel's surface mode and notify subscribers. */
export function setChannelSurfaceMode(
  channelId: string,
  mode: ChannelSurfaceMode,
): void {
  modes = { ...modes, [channelId]: mode };
  persist(MODE_STORAGE_KEY, modes);
  emit();
}

/** Whether the workspace is expanded (right pane and sidebar hidden). */
export function getWorkspaceExpanded(channelId: string): boolean {
  return expanded[channelId] ?? false;
}

/** Set the expanded state for a channel's workspace. */
export function setWorkspaceExpanded(
  channelId: string,
  isExpanded: boolean,
): void {
  expanded = { ...expanded, [channelId]: isExpanded };
  persist(EXPANDED_STORAGE_KEY, expanded);
  emit();
}

/** Clear every channel's surface state. Wired into resetCommunityState(). */
export function resetChannelSurfaceModes(): void {
  modes = {};
  expanded = {};
  persist(MODE_STORAGE_KEY, modes);
  persist(EXPANDED_STORAGE_KEY, expanded);
  emit();
}

/** Subscribe a component to a channel's surface mode. */
export function useChannelSurfaceMode(
  channelId: string | undefined,
): ChannelSurfaceMode {
  return React.useSyncExternalStore(
    subscribe,
    () => (channelId ? getChannelSurfaceMode(channelId) : DEFAULT_MODE),
    () => DEFAULT_MODE,
  );
}

/** Subscribe a component to a channel's workspace expanded state. */
export function useWorkspaceExpanded(channelId: string | undefined): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => (channelId ? getWorkspaceExpanded(channelId) : false),
    () => false,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/channelSurfaceMode.test.mjs`

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/channelSurfaceMode.ts \
        desktop/src/features/workspace/lib/channelSurfaceMode.test.mjs
git commit -s -m "feat(workspace): per-channel surface mode store"
```

---

## Task 2: Kind-agnostic tab store

The tab contract. This is the task the whole spec is built around, so the tests
below assert the *contract*, not just the data: the store must never branch on
`kind`, and `payload` must round-trip untouched.

**Files:**
- Create: `desktop/src/features/workspace/lib/workspaceTabs.ts`
- Test: `desktop/src/features/workspace/lib/workspaceTabs.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  `type WorkspaceTab = { id: string; kind: string; title: string; createdBy: string; payload: unknown }`,
  `type ChannelWorkspaceState = { tabs: WorkspaceTab[]; activeTabId: string | null }`,
  `getWorkspace(channelId: string): ChannelWorkspaceState`,
  `openTab(channelId: string, input: { kind: string; title: string; createdBy: string; payload: unknown }): string`,
  `closeTab(channelId: string, tabId: string): void`,
  `reopenLastClosedTab(channelId: string): string | null`,
  `setActiveTab(channelId: string, tabId: string): void`,
  `renameTab(channelId: string, tabId: string, title: string): void`,
  `moveTab(channelId: string, tabId: string, toIndex: number): void`,
  `updateTabPayload(channelId: string, tabId: string, payload: unknown): void`,
  `useWorkspace(channelId: string | undefined): ChannelWorkspaceState`,
  `resetWorkspaceTabs(): void`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/lib/workspaceTabs.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function freshStore(run) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const map = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  });
  try {
    const module = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    await run(module);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

const scratch = (title) => ({
  kind: "scratchpad",
  title,
  createdBy: "local",
  payload: { text: "" },
});

test("a channel with no tabs is empty and has no active tab", async () => {
  await freshStore((mod) => {
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(state.tabs, []);
    assert.equal(state.activeTabId, null);
  });
});

test("opening a tab makes it active and gives it a unique id", async () => {
  await freshStore((mod) => {
    const first = mod.openTab("chan-a", scratch("One"));
    const second = mod.openTab("chan-a", scratch("Two"));
    assert.notEqual(first, second);
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(
      state.tabs.map((tab) => tab.title),
      ["One", "Two"],
    );
    assert.equal(state.activeTabId, second);
  });
});

test("tabs are never shared across channels", async () => {
  await freshStore((mod) => {
    mod.openTab("chan-a", scratch("One"));
    assert.deepEqual(mod.getWorkspace("chan-b").tabs, []);
  });
});

test("the store round-trips an opaque payload without reading it", async () => {
  await freshStore((mod) => {
    const payload = { deeply: { nested: [1, 2, 3] }, handle: "pty-7" };
    const id = mod.openTab("chan-a", {
      kind: "some-future-kind",
      title: "Stub",
      createdBy: "local",
      payload,
    });
    const tab = mod.getWorkspace("chan-a").tabs.find((t) => t.id === id);
    assert.deepEqual(
      tab.payload,
      payload,
      "the workspace layer must not reshape a kind's payload",
    );
    mod.updateTabPayload("chan-a", id, { replaced: true });
    const updated = mod.getWorkspace("chan-a").tabs.find((t) => t.id === id);
    assert.deepEqual(updated.payload, { replaced: true });
  });
});

test("an unregistered kind is accepted, because the store is kind-agnostic", async () => {
  await freshStore((mod) => {
    const id = mod.openTab("chan-a", {
      kind: "terminal",
      title: "zsh",
      createdBy: "local",
      payload: {},
    });
    assert.equal(mod.getWorkspace("chan-a").tabs[0].id, id);
  });
});

test("closing the active tab activates its neighbour", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    const c = mod.openTab("chan-a", scratch("C"));
    mod.setActiveTab("chan-a", b);
    mod.closeTab("chan-a", b);
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(
      state.tabs.map((tab) => tab.id),
      [a, c],
    );
    assert.equal(state.activeTabId, c, "closing B should activate C");
  });
});

test("closing the last tab leaves no active tab", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    mod.closeTab("chan-a", a);
    assert.equal(mod.getWorkspace("chan-a").activeTabId, null);
  });
});

test("closing an inactive tab leaves the active tab alone", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    mod.closeTab("chan-a", a);
    assert.equal(mod.getWorkspace("chan-a").activeTabId, b);
  });
});

test("reopen restores the last closed tab with its payload and position", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", {
      kind: "scratchpad",
      title: "B",
      createdBy: "local",
      payload: { text: "kept" },
    });
    mod.openTab("chan-a", scratch("C"));
    mod.closeTab("chan-a", b);
    const reopened = mod.reopenLastClosedTab("chan-a");
    const state = mod.getWorkspace("chan-a");
    assert.equal(state.tabs[1].id, reopened, "reopens at its old index");
    assert.deepEqual(state.tabs[1].payload, { text: "kept" });
    assert.equal(state.tabs[0].id, a);
    assert.equal(state.activeTabId, reopened);
  });
});

test("reopen with nothing closed returns null", async () => {
  await freshStore((mod) => {
    assert.equal(mod.reopenLastClosedTab("chan-a"), null);
  });
});

test("moveTab reorders and clamps out-of-range targets", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    const c = mod.openTab("chan-a", scratch("C"));
    mod.moveTab("chan-a", c, 0);
    assert.deepEqual(
      mod.getWorkspace("chan-a").tabs.map((tab) => tab.id),
      [c, a, b],
    );
    mod.moveTab("chan-a", c, 99);
    assert.deepEqual(
      mod.getWorkspace("chan-a").tabs.map((tab) => tab.id),
      [a, b, c],
    );
  });
});

test("renameTab rejects an empty title", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    mod.renameTab("chan-a", a, "   ");
    assert.equal(mod.getWorkspace("chan-a").tabs[0].title, "A");
    mod.renameTab("chan-a", a, "Renamed");
    assert.equal(mod.getWorkspace("chan-a").tabs[0].title, "Renamed");
  });
});

test("tabs survive a reload, active tab included", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const map = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  });
  try {
    const first = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    const id = first.openTab("chan-a", scratch("Kept"));
    const second = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    const state = second.getWorkspace("chan-a");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].id, id);
    assert.equal(state.activeTabId, id);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("reset clears every channel", async () => {
  await freshStore((mod) => {
    mod.openTab("chan-a", scratch("A"));
    mod.openTab("chan-b", scratch("B"));
    mod.resetWorkspaceTabs();
    assert.deepEqual(mod.getWorkspace("chan-a").tabs, []);
    assert.deepEqual(mod.getWorkspace("chan-b").tabs, []);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/workspaceTabs.test.mjs`

Expected: FAIL with `Cannot find module './workspaceTabs.ts'`.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/workspace/lib/workspaceTabs.ts`:

```typescript
import * as React from "react";

/**
 * One workspace tab.
 *
 * `kind` names which registry entry renders the body. `payload` is
 * kind-scoped: the workspace layer stores and forwards it and must never read
 * or branch on its shape. That is what keeps a future `terminal` or `web` kind
 * from needing changes here.
 */
export type WorkspaceTab = {
  id: string;
  kind: string;
  title: string;
  /** Pubkey of the agent that created it, or "local" for the human. */
  createdBy: string;
  payload: unknown;
};

export type ChannelWorkspaceState = {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
};

type ClosedTab = { tab: WorkspaceTab; index: number };

const STORAGE_KEY = "buzz.channels.workspaceTabs";

const EMPTY: ChannelWorkspaceState = Object.freeze({
  tabs: Object.freeze([]) as unknown as WorkspaceTab[],
  activeTabId: null,
});

const listeners = new Set<() => void>();

let channels: Record<string, ChannelWorkspaceState> = readStored();
/** Undo stack for tab close, per channel. Deliberately not persisted. */
const closedStacks = new Map<string, ClosedTab[]>();

function isTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.kind === "string" &&
    typeof tab.title === "string" &&
    typeof tab.createdBy === "string"
  );
}

function readStored(): Record<string, ChannelWorkspaceState> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const result: Record<string, ChannelWorkspaceState> = {};
    for (const [channelId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const state = value as Record<string, unknown>;
      const tabs = Array.isArray(state.tabs) ? state.tabs.filter(isTab) : [];
      const activeTabId =
        typeof state.activeTabId === "string" &&
        tabs.some((tab) => tab.id === state.activeTabId)
          ? state.activeTabId
          : (tabs.at(-1)?.id ?? null);
      result[channelId] = { tabs, activeTabId };
    }
    return result;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(channels));
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}

function emit(): void {
  persist();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(
  channelId: string,
  update: (state: ChannelWorkspaceState) => ChannelWorkspaceState,
): void {
  const next = update(channels[channelId] ?? EMPTY);
  channels = { ...channels, [channelId]: next };
  emit();
}

function newTabId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}-${performance.now()}`;
}

/** Read a channel's workspace state outside of React. */
export function getWorkspace(channelId: string): ChannelWorkspaceState {
  return channels[channelId] ?? EMPTY;
}

/** Append a tab and make it active. Returns the new tab id. */
export function openTab(
  channelId: string,
  input: {
    kind: string;
    title: string;
    createdBy: string;
    payload: unknown;
  },
): string {
  const id = newTabId();
  write(channelId, (state) => ({
    tabs: [...state.tabs, { id, ...input }],
    activeTabId: id,
  }));
  return id;
}

/**
 * Close a tab. When the closed tab was active, the tab that took its index
 * becomes active, falling back to the new last tab.
 */
export function closeTab(channelId: string, tabId: string): void {
  write(channelId, (state) => {
    const index = state.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return state;
    const stack = closedStacks.get(channelId) ?? [];
    stack.push({ tab: state.tabs[index], index });
    closedStacks.set(channelId, stack);
    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    if (state.activeTabId !== tabId) return { tabs, activeTabId: state.activeTabId };
    const next = tabs[index] ?? tabs.at(-1) ?? null;
    return { tabs, activeTabId: next ? next.id : null };
  });
}

/** Restore the most recently closed tab at its old index. */
export function reopenLastClosedTab(channelId: string): string | null {
  const stack = closedStacks.get(channelId);
  const restored = stack?.pop();
  if (!restored) return null;
  write(channelId, (state) => {
    const tabs = [...state.tabs];
    tabs.splice(Math.min(restored.index, tabs.length), 0, restored.tab);
    return { tabs, activeTabId: restored.tab.id };
  });
  return restored.tab.id;
}

/** Make a tab active. Unknown ids are ignored. */
export function setActiveTab(channelId: string, tabId: string): void {
  write(channelId, (state) =>
    state.tabs.some((tab) => tab.id === tabId)
      ? { ...state, activeTabId: tabId }
      : state,
  );
}

/** Rename a tab. Blank titles are rejected. */
export function renameTab(
  channelId: string,
  tabId: string,
  title: string,
): void {
  const trimmed = title.trim();
  if (!trimmed) return;
  write(channelId, (state) => ({
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, title: trimmed } : tab,
    ),
  }));
}

/** Move a tab to an index, clamped into range. */
export function moveTab(
  channelId: string,
  tabId: string,
  toIndex: number,
): void {
  write(channelId, (state) => {
    const from = state.tabs.findIndex((tab) => tab.id === tabId);
    if (from === -1) return state;
    const tabs = [...state.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, moved);
    return { ...state, tabs };
  });
}

/** Replace a tab's kind-scoped payload. */
export function updateTabPayload(
  channelId: string,
  tabId: string,
  payload: unknown,
): void {
  write(channelId, (state) => ({
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, payload } : tab,
    ),
  }));
}

/** Clear every channel's tabs. Wired into resetCommunityState(). */
export function resetWorkspaceTabs(): void {
  channels = {};
  closedStacks.clear();
  emit();
}

/** Subscribe a component to a channel's workspace state. */
export function useWorkspace(
  channelId: string | undefined,
): ChannelWorkspaceState {
  return React.useSyncExternalStore(
    subscribe,
    () => (channelId ? getWorkspace(channelId) : EMPTY),
    () => EMPTY,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/workspaceTabs.test.mjs`

Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/workspaceTabs.ts \
        desktop/src/features/workspace/lib/workspaceTabs.test.mjs
git commit -s -m "feat(workspace): kind-agnostic per-channel tab store"
```

---

## Task 3: Tab kind registry

The registry is the seam the spec's rule 3 demands: the shared layer looks up a
kind and renders it, and never hardcodes anything web-specific. The test proves
kind-agnosticism by registering a stub kind that ships in no UI, exactly as the
spec asks ("the proof that the contract is kind-agnostic is a stub kind
exercised in tests, not shipped UI").

**Files:**
- Create: `desktop/src/features/workspace/lib/tabKindRegistry.ts`
- Test: `desktop/src/features/workspace/lib/tabKindRegistry.test.mjs`

**Interfaces:**
- Consumes: `WorkspaceTab` from Task 2.
- Produces:
  `type TabKindDefinition = { kind: string; label: string; createTitle: () => string; createPayload: () => unknown; canCreateFromNewTabPage: boolean }`,
  `registerTabKind(definition: TabKindDefinition): void`,
  `getTabKind(kind: string): TabKindDefinition | undefined`,
  `listCreatableTabKinds(): TabKindDefinition[]`,
  `clearTabKindRegistry(): void`.

Body components are attached in Task 4 via a separate `.tsx` map, so this module
stays a plain `.ts` file that `node --test` can strip-type without JSX.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/lib/tabKindRegistry.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function freshRegistry(run) {
  const module = await import(`./tabKindRegistry.ts?test=${importSequence++}`);
  module.clearTabKindRegistry();
  await run(module);
}

const stubKind = {
  kind: "stub",
  label: "Stub",
  createTitle: () => "Stub tab",
  createPayload: () => ({ stub: true }),
  canCreateFromNewTabPage: false,
};

test("an unregistered kind resolves to undefined rather than throwing", async () => {
  await freshRegistry((mod) => {
    assert.equal(mod.getTabKind("nope"), undefined);
  });
});

test("a kind the UI never ships still registers and resolves", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    const found = mod.getTabKind("stub");
    assert.equal(found.label, "Stub");
    assert.deepEqual(found.createPayload(), { stub: true });
  });
});

test("the new-tab page only offers kinds that opt in", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    mod.registerTabKind({
      kind: "scratchpad",
      label: "Scratchpad",
      createTitle: () => "Untitled",
      createPayload: () => ({ text: "" }),
      canCreateFromNewTabPage: true,
    });
    assert.deepEqual(
      mod.listCreatableTabKinds().map((definition) => definition.kind),
      ["scratchpad"],
      "the stub kind must not appear in shipped UI",
    );
  });
});

test("registering the same kind twice is rejected", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    assert.throws(
      () => mod.registerTabKind(stubKind),
      /already registered/,
      "a duplicate kind is a programming error, not a silent overwrite",
    );
  });
});

test("creatable kinds keep registration order", async () => {
  await freshRegistry((mod) => {
    for (const kind of ["a", "b", "c"]) {
      mod.registerTabKind({
        kind,
        label: kind.toUpperCase(),
        createTitle: () => kind,
        createPayload: () => ({}),
        canCreateFromNewTabPage: true,
      });
    }
    assert.deepEqual(
      mod.listCreatableTabKinds().map((definition) => definition.kind),
      ["a", "b", "c"],
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/tabKindRegistry.test.mjs`

Expected: FAIL with `Cannot find module './tabKindRegistry.ts'`.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/workspace/lib/tabKindRegistry.ts`:

```typescript
/**
 * What the workspace needs to know about a tab kind.
 *
 * Everything kind-specific lives behind this definition. The workspace shell
 * looks a kind up, asks it for a title and an initial payload, and renders the
 * body registered for it. It never branches on the kind string itself.
 */
export type TabKindDefinition = {
  /** Stable identifier stored on the tab. Never renamed once shipped. */
  kind: string;
  /** Human-facing name in the new-tab page and tab context menus. */
  label: string;
  /** Title a freshly created tab gets. */
  createTitle: () => string;
  /** Initial kind-scoped payload. Opaque to the workspace layer. */
  createPayload: () => unknown;
  /**
   * Whether the new-tab page offers this kind. A kind can be registered and
   * fully functional while staying out of shipped UI, which is how the
   * kind-agnostic contract is proven without building a second surface.
   */
  canCreateFromNewTabPage: boolean;
};

const registry = new Map<string, TabKindDefinition>();

/** Register a kind. Throws on a duplicate: that is always a wiring bug. */
export function registerTabKind(definition: TabKindDefinition): void {
  if (registry.has(definition.kind)) {
    throw new Error(`tab kind "${definition.kind}" is already registered`);
  }
  registry.set(definition.kind, definition);
}

/** Look a kind up. Unknown kinds resolve to undefined, never throw: a tab
 * restored from storage may name a kind this build does not have. */
export function getTabKind(kind: string): TabKindDefinition | undefined {
  return registry.get(kind);
}

/** Kinds the new-tab page should offer, in registration order. */
export function listCreatableTabKinds(): TabKindDefinition[] {
  return [...registry.values()].filter(
    (definition) => definition.canCreateFromNewTabPage,
  );
}

/** Test-only: empty the registry between cases. */
export function clearTabKindRegistry(): void {
  registry.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/tabKindRegistry.test.mjs`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/tabKindRegistry.ts \
        desktop/src/features/workspace/lib/tabKindRegistry.test.mjs
git commit -s -m "feat(workspace): kind registry with stub-kind proof"
```

---

## Task 4: Scratchpad kind and the body map

The first shipping kind, and the module that binds kinds to React bodies. This
task exists before the shell so the shell has something real to render.

**Files:**
- Create: `desktop/src/features/workspace/kinds/scratchpadKind.tsx`
- Create: `desktop/src/features/workspace/kinds/index.tsx`
- Test: `desktop/src/features/workspace/kinds/scratchpadKind.test.mjs`

**Interfaces:**
- Consumes: `registerTabKind`, `TabKindDefinition` (Task 3); `WorkspaceTab`,
  `updateTabPayload` (Task 2).
- Produces:
  `type TabBodyProps = { channelId: string; tab: WorkspaceTab }`,
  `scratchpadKindDefinition: TabKindDefinition`,
  `readScratchpadText(payload: unknown): string`,
  `ScratchpadBody: React.ComponentType<TabBodyProps>`,
  `getTabBody(kind: string): React.ComponentType<TabBodyProps> | undefined`,
  `registerAllTabKinds(): void`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/kinds/scratchpadKind.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function load(run) {
  const module = await import(`./scratchpadKind.tsx?test=${importSequence++}`);
  await run(module);
}

test("a new scratchpad starts empty and untitled", async () => {
  await load((mod) => {
    assert.equal(mod.scratchpadKindDefinition.kind, "scratchpad");
    assert.equal(mod.scratchpadKindDefinition.canCreateFromNewTabPage, true);
    assert.deepEqual(mod.scratchpadKindDefinition.createPayload(), {
      text: "",
    });
    assert.equal(mod.scratchpadKindDefinition.createTitle(), "Untitled");
  });
});

test("reading text tolerates a payload from a different build", async () => {
  await load((mod) => {
    assert.equal(mod.readScratchpadText({ text: "hello" }), "hello");
    assert.equal(mod.readScratchpadText({ text: 42 }), "");
    assert.equal(mod.readScratchpadText(null), "");
    assert.equal(mod.readScratchpadText(undefined), "");
    assert.equal(mod.readScratchpadText("not an object"), "");
    assert.equal(mod.readScratchpadText({ other: "field" }), "");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/kinds/scratchpadKind.test.mjs`

Expected: FAIL with `Cannot find module './scratchpadKind.tsx'`.

- [ ] **Step 3: Write the scratchpad kind**

Create `desktop/src/features/workspace/kinds/scratchpadKind.tsx`:

```tsx
import * as React from "react";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  updateTabPayload,
  type WorkspaceTab,
} from "@/features/workspace/lib/workspaceTabs";

/** Props every tab body receives. Bodies own their toolbar and their state. */
export type TabBodyProps = {
  channelId: string;
  tab: WorkspaceTab;
};

/**
 * Read the text out of a scratchpad payload.
 *
 * Payloads are persisted, so a payload written by an older build can reach a
 * newer one. Anything unexpected reads as empty rather than throwing.
 */
export function readScratchpadText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

export const scratchpadKindDefinition: TabKindDefinition = {
  kind: "scratchpad",
  label: "Scratchpad",
  createTitle: () => "Untitled",
  createPayload: () => ({ text: "" }),
  canCreateFromNewTabPage: true,
};

/** A plain local notepad. No relay, no agent, no persistence beyond the tab. */
export function ScratchpadBody({
  channelId,
  tab,
}: TabBodyProps): React.JSX.Element {
  const text = readScratchpadText(tab.payload);
  return (
    <textarea
      aria-label={`Scratchpad: ${tab.title}`}
      className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
      data-testid="workspace-scratchpad-body"
      onChange={(event) =>
        updateTabPayload(channelId, tab.id, { text: event.target.value })
      }
      placeholder="Notes, snippets, anything. Local to this channel."
      spellCheck={false}
      value={text}
    />
  );
}
```

- [ ] **Step 4: Write the body map**

Create `desktop/src/features/workspace/kinds/index.tsx`:

```tsx
import type * as React from "react";

import { registerTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  ScratchpadBody,
  scratchpadKindDefinition,
  type TabBodyProps,
} from "@/features/workspace/kinds/scratchpadKind";

/**
 * Kind string to body component.
 *
 * Kept separate from the registry so the registry stays a plain `.ts` module
 * that the `node --test` type-stripper can load without JSX.
 */
const bodies = new Map<string, React.ComponentType<TabBodyProps>>();

let registered = false;

/** Look up the body for a kind. Unknown kinds render a fallback in the shell. */
export function getTabBody(
  kind: string,
): React.ComponentType<TabBodyProps> | undefined {
  return bodies.get(kind);
}

/**
 * Register every shipping kind. Idempotent, because the workspace shell calls
 * it on mount and a channel remount must not throw on a duplicate kind.
 */
export function registerAllTabKinds(): void {
  if (registered) return;
  registered = true;
  registerTabKind(scratchpadKindDefinition);
  bodies.set(scratchpadKindDefinition.kind, ScratchpadBody);
}

export type { TabBodyProps };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/kinds/scratchpadKind.test.mjs`

Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/workspace/kinds/
git commit -s -m "feat(workspace): scratchpad tab kind and body map"
```

---

## Task 5: Tab strip and workspace shell

**Files:**
- Create: `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx`
- Create: `desktop/src/features/workspace/ui/NewTabPage.tsx`
- Create: `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1 to 4.
- Produces: `ChannelWorkspace: React.ComponentType<{ channelId: string }>`.

- [ ] **Step 1: Write the tab strip**

Create `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx`:

```tsx
import * as React from "react";
import { Maximize2, Minimize2, Plus, X } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

type WorkspaceTabStripProps = {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  isExpanded: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onToggleExpanded: () => void;
};

/**
 * The one tab strip. There is exactly one level of tabs in a workspace, so this
 * component is never nested inside a tab body.
 */
export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  isExpanded,
  onSelect,
  onClose,
  onNewTab,
  onToggleExpanded,
}: WorkspaceTabStripProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1"
      data-testid="workspace-tab-strip"
      role="tablist"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            className={cn(
              "group flex min-w-0 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs",
              tab.id === activeTabId
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60",
            )}
            data-testid={`workspace-tab-${tab.id}`}
            key={tab.id}
          >
            <button
              aria-selected={tab.id === activeTabId}
              className="max-w-[12rem] truncate outline-none"
              onClick={() => onSelect(tab.id)}
              role="tab"
              type="button"
            >
              {tab.title}
            </button>
            <button
              aria-label={`Close ${tab.title}`}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
        <button
          aria-label="New tab"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background/60"
          data-testid="workspace-new-tab"
          onClick={onNewTab}
          type="button"
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
      <button
        aria-label={isExpanded ? "Collapse workspace" : "Expand workspace"}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background/60"
        data-testid="workspace-expand-toggle"
        onClick={onToggleExpanded}
        type="button"
      >
        {isExpanded ? (
          <Minimize2 aria-hidden className="size-4" />
        ) : (
          <Maximize2 aria-hidden className="size-4" />
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write the new-tab page**

Create `desktop/src/features/workspace/ui/NewTabPage.tsx`:

```tsx
import * as React from "react";

import { listCreatableTabKinds } from "@/features/workspace/lib/tabKindRegistry";

type NewTabPageProps = {
  onCreate: (kind: string) => void;
};

/** Empty state: the kinds this build can create. */
export function NewTabPage({ onCreate }: NewTabPageProps): React.JSX.Element {
  const kinds = listCreatableTabKinds();
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8"
      data-testid="workspace-new-tab-page"
    >
      <p className="text-sm text-muted-foreground">
        Open something in this channel&apos;s workspace.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {kinds.map((definition) => (
          <button
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
            data-testid={`workspace-create-${definition.kind}`}
            key={definition.kind}
            onClick={() => onCreate(definition.kind)}
            type="button"
          >
            {definition.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the workspace shell**

Create `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`:

```tsx
import * as React from "react";

import {
  setWorkspaceExpanded,
  useWorkspaceExpanded,
} from "@/features/workspace/lib/channelSurfaceMode";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  closeTab,
  openTab,
  setActiveTab,
  useWorkspace,
} from "@/features/workspace/lib/workspaceTabs";
import {
  getTabBody,
  registerAllTabKinds,
} from "@/features/workspace/kinds";
import { NewTabPage } from "@/features/workspace/ui/NewTabPage";
import { WorkspaceTabStrip } from "@/features/workspace/ui/WorkspaceTabStrip";

type ChannelWorkspaceProps = {
  channelId: string;
};

/**
 * The channel workspace: one tab strip over one active tab body.
 *
 * The shell owns the strip, the lifecycle, and which tab is active. It never
 * reads a tab's payload and never branches on its kind beyond a registry
 * lookup, so a new kind is a registration rather than a change here.
 */
export function ChannelWorkspace({
  channelId,
}: ChannelWorkspaceProps): React.JSX.Element {
  registerAllTabKinds();

  const { tabs, activeTabId } = useWorkspace(channelId);
  const isExpanded = useWorkspaceExpanded(channelId);

  const handleCreate = React.useCallback(
    (kind: string) => {
      const definition = getTabKind(kind);
      if (!definition) return;
      openTab(channelId, {
        kind: definition.kind,
        title: definition.createTitle(),
        createdBy: "local",
        payload: definition.createPayload(),
      });
    },
    [channelId],
  );

  const handleNewTab = React.useCallback(() => {
    // The new-tab page renders when nothing is active, so this only needs to
    // clear the active tab rather than create one of a guessed kind.
    const first = tabs.at(0);
    if (first) setActiveTab(channelId, first.id);
  }, [channelId, tabs]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const Body = activeTab ? getTabBody(activeTab.kind) : undefined;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="channel-workspace"
    >
      <WorkspaceTabStrip
        activeTabId={activeTabId}
        isExpanded={isExpanded}
        onClose={(tabId) => closeTab(channelId, tabId)}
        onNewTab={handleNewTab}
        onSelect={(tabId) => setActiveTab(channelId, tabId)}
        onToggleExpanded={() => setWorkspaceExpanded(channelId, !isExpanded)}
        tabs={tabs}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {activeTab && Body ? (
          <Body channelId={channelId} tab={activeTab} />
        ) : activeTab ? (
          <div
            className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
            data-testid="workspace-unknown-kind"
          >
            This tab needs a newer version of the app to open.
          </div>
        ) : (
          <NewTabPage onCreate={handleCreate} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify it type-checks and lints**

Run: `cd desktop && pnpm check`

Expected: PASS, no biome or TypeScript errors, no `check:px-text` failures.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/ui/
git commit -s -m "feat(workspace): tab strip, new-tab page, and workspace shell"
```

---

## Task 6: Wire the workspace into the channel content column

The insertion point is exact: `ChannelPane.tsx:629` renders `<MessageTimeline>`
inside the content column. The header at line 615 and the `RightAuxiliaryPane`
at line 540 must not move, because the spec requires an open thread to stay
readable beside the workspace.

**Files:**
- Modify: `desktop/src/features/channels/ui/ChannelPane.tsx:629`
- Modify: `desktop/src/features/channels/ui/ChannelScreenHeader.tsx`

**Interfaces:**
- Consumes: `ChannelWorkspace` (Task 5), `useChannelSurfaceMode`,
  `setChannelSurfaceMode` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Read the current timeline block**

Run: `sed -n '600,700p' desktop/src/features/channels/ui/ChannelPane.tsx`

Confirm `<MessageTimeline` opens at line 629 and note the line its closing
`/>` sits on. The next step wraps exactly that element.

- [ ] **Step 2: Swap the content-column occupant**

In `ChannelPane.tsx`, add to the imports:

```tsx
import { useChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { ChannelWorkspace } from "@/features/workspace/ui/ChannelWorkspace";
```

Add near the other hooks in the component body:

```tsx
const surfaceMode = useChannelSurfaceMode(activeChannel?.id);
```

Replace the `<MessageTimeline ... />` element (starting line 629) with:

```tsx
{surfaceMode === "workspace" && activeChannel?.id ? (
  <ChannelWorkspace channelId={activeChannel.id} />
) : (
  <MessageTimeline
    ref={messageTimelineRef}
    channelId={activeChannel?.id}
    /* ...every existing prop, unchanged... */
  />
)}
```

Keep every existing `MessageTimeline` prop exactly as it was. Do not delete
`messageTimelineRef`: other code in this file calls
`messageTimelineRef.current?.scrollToBottomOnNextUpdate()` and a null ref is
already handled by the optional chaining.

- [ ] **Step 3: Add the Workspace toggle to the channel header**

In `ChannelScreenHeader.tsx`, add the imports:

```tsx
import { LayoutGrid } from "lucide-react";

import {
  setChannelSurfaceMode,
  useChannelSurfaceMode,
} from "@/features/workspace/lib/channelSurfaceMode";
```

Add the button beside the existing header actions:

```tsx
{channelId ? (
  <button
    aria-label={
      surfaceMode === "workspace" ? "Show message timeline" : "Show workspace"
    }
    aria-pressed={surfaceMode === "workspace"}
    className={cn(
      "rounded-md p-1.5 text-muted-foreground hover:bg-muted",
      surfaceMode === "workspace" && "bg-muted text-foreground",
    )}
    data-testid="channel-workspace-toggle"
    onClick={() =>
      setChannelSurfaceMode(
        channelId,
        surfaceMode === "workspace" ? "timeline" : "workspace",
      )
    }
    type="button"
  >
    <LayoutGrid aria-hidden className="size-4" />
  </button>
) : null}
```

with `const surfaceMode = useChannelSurfaceMode(channelId);` in the component
body. If `ChannelScreenHeader` does not already receive `channelId`, thread it
through from `ChannelScreen.tsx:746` where `channelHeader` is built.

- [ ] **Step 4: Verify the app builds and the toggle works**

Run:

```bash
cd desktop && pnpm check && pnpm build:e2e
just desktop-screenshot --name workspace-off --route /channels/general
just desktop-screenshot --name workspace-on --route /channels/general --click channel-workspace-toggle
```

Expected: two PNG paths on stdout. Confirm they differ:

```bash
shasum -a 256 test-results/screenshots/workspace-*.png
```

Both hashes must be different. Identical hashes mean the toggle did not change
the rendered surface: fix that before continuing.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/channels/ui/ChannelPane.tsx \
        desktop/src/features/channels/ui/ChannelScreenHeader.tsx
git commit -s -m "feat(workspace): render the workspace in the channel content column"
```

---

## Task 7: Thread view mode override while the workspace is on

The spec: "While workspace mode is on, threads open in split, not focus. The
`ThreadViewMode` preference is preserved and restored on exit; it is overridden,
not overwritten." Focus mode is an overlay drawer, and overlaying the workspace
would hide the thing the user just chose to look at.

**Files:**
- Create: `desktop/src/features/workspace/lib/effectiveThreadViewMode.ts`
- Test: `desktop/src/features/workspace/lib/effectiveThreadViewMode.test.mjs`
- Modify: wherever `useThreadViewMode()` is consumed for channel layout
  (find with `grep -rn "useThreadViewMode" desktop/src`)

**Interfaces:**
- Consumes: `ThreadViewMode` from
  `@/features/channels/lib/threadViewModePreference`, `ChannelSurfaceMode` (Task 1).
- Produces:
  `effectiveThreadViewMode(preference: ThreadViewMode, surfaceMode: ChannelSurfaceMode): ThreadViewMode`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/lib/effectiveThreadViewMode.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const { effectiveThreadViewMode } = await import(
  "./effectiveThreadViewMode.ts"
);

test("workspace mode forces split even when focus is preferred", () => {
  assert.equal(effectiveThreadViewMode("focus", "workspace"), "split");
  assert.equal(effectiveThreadViewMode("split", "workspace"), "split");
});

test("timeline mode honours the stored preference exactly", () => {
  assert.equal(effectiveThreadViewMode("focus", "timeline"), "focus");
  assert.equal(effectiveThreadViewMode("split", "timeline"), "split");
});

test("the override is pure, so the stored preference is never mutated", () => {
  const preference = "focus";
  effectiveThreadViewMode(preference, "workspace");
  assert.equal(
    preference,
    "focus",
    "leaving the workspace must restore focus mode",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/effectiveThreadViewMode.test.mjs`

Expected: FAIL with `Cannot find module './effectiveThreadViewMode.ts'`.

- [ ] **Step 3: Write the implementation**

Create `desktop/src/features/workspace/lib/effectiveThreadViewMode.ts`:

```typescript
import type { ThreadViewMode } from "@/features/channels/lib/threadViewModePreference";
import type { ChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";

/**
 * How a thread should open, given the user's preference and the channel's
 * current surface.
 *
 * `focus` is an overlay drawer across the content column. Overlaying the
 * workspace would hide the surface the user just chose, so workspace mode
 * forces `split`. This is a pure override: the stored preference is untouched
 * and applies again the moment the channel returns to the timeline.
 */
export function effectiveThreadViewMode(
  preference: ThreadViewMode,
  surfaceMode: ChannelSurfaceMode,
): ThreadViewMode {
  return surfaceMode === "workspace" ? "split" : preference;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/lib/effectiveThreadViewMode.test.mjs`

Expected: PASS (3 tests).

- [ ] **Step 5: Apply the override at the consumer**

Run: `grep -rn "useThreadViewMode()" desktop/src`

At each site that drives *channel* layout (not the settings panel, which must
keep showing the stored preference), wrap the value:

```tsx
const threadViewPreference = useThreadViewMode();
const surfaceMode = useChannelSurfaceMode(activeChannel?.id);
const threadViewMode = effectiveThreadViewMode(
  threadViewPreference,
  surfaceMode,
);
```

Leave `SettingsPanels.tsx` reading `useThreadViewMode()` directly.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/workspace/lib/effectiveThreadViewMode.ts \
        desktop/src/features/workspace/lib/effectiveThreadViewMode.test.mjs \
        desktop/src/features/channels/
git commit -s -m "feat(workspace): force split threads while the workspace is open"
```

---

## Task 8: `read_workspace_file` Tauri command

The `file` and `image` kinds both need to read a local file. One command serves
both: it returns the bytes plus a sniffed MIME type, and the kinds decide how to
render.

**Files:**
- Create: `desktop/src-tauri/src/commands/workspace_files.rs`
- Modify: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (invoke handler)

**Interfaces:**
- Consumes: nothing.
- Produces: Tauri command `read_workspace_file(path: String) -> Result<WorkspaceFile, String>`
  where `WorkspaceFile { path: String, name: String, mime: String, bytes_base64: String, size: u64 }`.

- [ ] **Step 1: Write the failing test**

Create the file with only its test module first:

```rust
//! Read a local file for a workspace `file` or `image` tab.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_is_sniffed_from_the_extension() {
        assert_eq!(sniff_mime("photo.PNG"), "image/png");
        assert_eq!(sniff_mime("a/b/photo.jpg"), "image/jpeg");
        assert_eq!(sniff_mime("notes.md"), "text/markdown");
        assert_eq!(sniff_mime("main.rs"), "text/plain");
        assert_eq!(sniff_mime("mystery"), "application/octet-stream");
    }

    #[test]
    fn text_mimes_are_recognized_for_the_file_kind() {
        assert!(is_text_mime("text/plain"));
        assert!(is_text_mime("text/markdown"));
        assert!(is_text_mime("application/json"));
        assert!(!is_text_mime("image/png"));
    }

    #[tokio::test]
    async fn reading_a_real_file_returns_its_bytes_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        std::fs::write(&path, b"# hello").unwrap();
        let file = read_file(path.to_string_lossy().as_ref()).await.unwrap();
        assert_eq!(file.name, "notes.md");
        assert_eq!(file.mime, "text/markdown");
        assert_eq!(file.size, 7);
        assert_eq!(
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(&file.bytes_base64)
                    .unwrap()
            )
            .unwrap(),
            "# hello"
        );
    }

    #[tokio::test]
    async fn a_missing_file_reports_the_path() {
        let err = read_file("/nonexistent/nope.txt").await.unwrap_err();
        assert!(err.contains("nope.txt"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn a_file_over_the_cap_is_refused_rather_than_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![0u8; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let err = read_file(path.to_string_lossy().as_ref()).await.unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml workspace_files`

Expected: FAIL with `cannot find function sniff_mime` and friends.

- [ ] **Step 3: Write the implementation**

Prepend to `workspace_files.rs`:

```rust
use base64::Engine as _;
use serde::Serialize;

/// Largest file a workspace tab will load. Bodies are base64 in an IPC
/// response, so this is a memory bound, not a policy.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// A file loaded for a workspace tab.
#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceFile {
    pub path: String,
    pub name: String,
    pub mime: String,
    pub bytes_base64: String,
    pub size: u64,
}

/// Guess a MIME type from a path's extension.
pub fn sniff_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "toml" | "yaml"
        | "yml" | "css" | "html" | "sh" | "py" | "dart" | "sql" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Whether a MIME type should render in the `file` kind's text view.
pub fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/") || mime == "application/json"
}

async fn read_file(path: &str) -> Result<WorkspaceFile, String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{path} is too large: {} bytes, cap is {MAX_FILE_BYTES}",
            meta.len()
        ));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    let name = std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string();
    Ok(WorkspaceFile {
        path: path.to_string(),
        name,
        mime: sniff_mime(path).to_string(),
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: meta.len(),
    })
}

/// Read a local file for a workspace tab.
#[tauri::command]
pub async fn read_workspace_file(path: String) -> Result<WorkspaceFile, String> {
    read_file(&path).await
}
```

Add to `desktop/src-tauri/Cargo.toml` under `[dev-dependencies]` if absent:

```toml
tempfile = "3"
```

Register in `commands/mod.rs`:

```rust
pub mod workspace_files;
```

and add `commands::workspace_files::read_workspace_file` to the
`tauri::generate_handler![...]` list in `lib.rs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path desktop/src-tauri/Cargo.toml workspace_files`

Expected: PASS (5 tests).

- [ ] **Step 5: Format from the main checkout, then commit**

`just desktop-tauri-fmt` fails inside a git worktree, so run it from the main
checkout if you are in one, then:

```bash
git add desktop/src-tauri/
git commit -s -m "feat(workspace): read_workspace_file command for file and image tabs"
```

---

## Task 9: `file` and `image` kinds

**Files:**
- Create: `desktop/src/features/workspace/kinds/fileKind.tsx`
- Create: `desktop/src/features/workspace/kinds/imageKind.tsx`
- Test: `desktop/src/features/workspace/kinds/filePayload.test.mjs`
- Create: `desktop/src/features/workspace/lib/filePayload.ts`
- Modify: `desktop/src/features/workspace/kinds/index.tsx`

**Interfaces:**
- Consumes: `TabBodyProps` (Task 4), `read_workspace_file` (Task 8).
- Produces: `readFilePath(payload: unknown): string | null`,
  `fileKindDefinition`, `FileBody`, `imageKindDefinition`, `ImageBody`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/kinds/filePayload.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const { readFilePath, titleForPath } = await import(
  "../lib/filePayload.ts"
);

test("a payload without a usable path reads as null", () => {
  assert.equal(readFilePath(null), null);
  assert.equal(readFilePath({}), null);
  assert.equal(readFilePath({ path: 42 }), null);
  assert.equal(readFilePath({ path: "   " }), null);
});

test("a payload with a path reads it back trimmed", () => {
  assert.equal(readFilePath({ path: " /a/b.md " }), "/a/b.md");
});

test("the tab title is the file name, not the whole path", () => {
  assert.equal(titleForPath("/Users/x/notes/todo.md"), "todo.md");
  assert.equal(titleForPath("todo.md"), "todo.md");
  assert.equal(titleForPath(""), "Untitled");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && pnpm test -- src/features/workspace/kinds/filePayload.test.mjs`

Expected: FAIL with `Cannot find module '../lib/filePayload.ts'`.

- [ ] **Step 3: Write the payload helpers**

Create `desktop/src/features/workspace/lib/filePayload.ts`:

```typescript
/** Read a file path out of a `file` or `image` tab payload. */
export function readFilePath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const path = (payload as Record<string, unknown>).path;
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A tab title for a path: the file name, never the whole path. */
export function titleForPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.trim();
  return name && name.length > 0 ? name : "Untitled";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && pnpm test -- src/features/workspace/kinds/filePayload.test.mjs`

Expected: PASS (3 tests).

- [ ] **Step 5: Write the file kind**

Create `desktop/src/features/workspace/kinds/fileKind.tsx`:

```tsx
import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import { readFilePath, titleForPath } from "@/features/workspace/lib/filePayload";
import {
  renameTab,
  updateTabPayload,
} from "@/features/workspace/lib/workspaceTabs";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

type WorkspaceFile = {
  path: string;
  name: string;
  mime: string;
  bytes_base64: string;
  size: number;
};

export const fileKindDefinition: TabKindDefinition = {
  kind: "file",
  label: "File",
  createTitle: () => "Open a file",
  createPayload: () => ({ path: null }),
  canCreateFromNewTabPage: true,
};

function decodeText(bytesBase64: string): string {
  const binary = globalThis.atob(bytesBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Read-only file viewer. Editing and saving land in a later phase. */
export function FileBody({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const path = readFilePath(tab.payload);
  const [file, setFile] = React.useState<WorkspaceFile | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!path) {
      setFile(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    invoke<WorkspaceFile>("read_workspace_file", { path })
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handlePick = React.useCallback(async () => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked !== "string") return;
    updateTabPayload(channelId, tab.id, { path: picked });
    renameTab(channelId, tab.id, titleForPath(picked));
  }, [channelId, tab.id]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <button
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          data-testid="workspace-file-pick"
          onClick={() => void handlePick()}
          type="button"
        >
          Choose a file
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 text-sm text-destructive"
        data-testid="workspace-file-error"
      >
        {error}
      </div>
    );
  }

  if (!file) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Loading {path}…</div>
    );
  }

  return (
    <pre
      className="h-full overflow-auto p-4 font-mono text-xs text-foreground"
      data-testid="workspace-file-body"
    >
      {decodeText(file.bytes_base64)}
    </pre>
  );
}
```

- [ ] **Step 6: Write the image kind**

Create `desktop/src/features/workspace/kinds/imageKind.tsx`:

```tsx
import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import { readFilePath, titleForPath } from "@/features/workspace/lib/filePayload";
import {
  renameTab,
  updateTabPayload,
} from "@/features/workspace/lib/workspaceTabs";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

type WorkspaceFile = {
  path: string;
  name: string;
  mime: string;
  bytes_base64: string;
  size: number;
};

export const imageKindDefinition: TabKindDefinition = {
  kind: "image",
  label: "Image",
  createTitle: () => "Open an image",
  createPayload: () => ({ path: null }),
  canCreateFromNewTabPage: true,
};

/** Image viewer. Bytes arrive over IPC as a data URL: no asset protocol
 * configuration and no file:// exposure. */
export function ImageBody({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const path = readFilePath(tab.payload);
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!path) {
      setSource(null);
      return;
    }
    let cancelled = false;
    setError(null);
    invoke<WorkspaceFile>("read_workspace_file", { path })
      .then((file) => {
        if (cancelled) return;
        if (!file.mime.startsWith("image/")) {
          setError(`${file.name} is not an image (${file.mime})`);
          return;
        }
        setSource(`data:${file.mime};base64,${file.bytes_base64}`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handlePick = React.useCallback(async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    });
    if (typeof picked !== "string") return;
    updateTabPayload(channelId, tab.id, { path: picked });
    renameTab(channelId, tab.id, titleForPath(picked));
  }, [channelId, tab.id]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <button
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          data-testid="workspace-image-pick"
          onClick={() => void handlePick()}
          type="button"
        >
          Choose an image
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 text-sm text-destructive"
        data-testid="workspace-image-error"
      >
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      {source ? (
        <img
          alt={tab.title}
          className="max-h-full max-w-full object-contain"
          data-testid="workspace-image-body"
          src={source}
        />
      ) : (
        <span className="text-sm text-muted-foreground">Loading…</span>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Register both kinds**

In `desktop/src/features/workspace/kinds/index.tsx`, extend
`registerAllTabKinds()`:

```tsx
import { FileBody, fileKindDefinition } from "@/features/workspace/kinds/fileKind";
import { ImageBody, imageKindDefinition } from "@/features/workspace/kinds/imageKind";

// ...inside registerAllTabKinds(), after the scratchpad registration:
registerTabKind(fileKindDefinition);
bodies.set(fileKindDefinition.kind, FileBody);
registerTabKind(imageKindDefinition);
bodies.set(imageKindDefinition.kind, ImageBody);
```

- [ ] **Step 8: Verify**

Run: `cd desktop && pnpm check && pnpm test`

Expected: PASS, all suites.

- [ ] **Step 9: Commit**

```bash
git add desktop/src/features/workspace/
git commit -s -m "feat(workspace): file and image tab kinds"
```

---

## Task 10: Community teardown

Both new stores are keyed by channel id, so they must be cleared on community
switch. Skipping this leaks one community's tabs into another, which is the
exact failure mode `resetCommunityState()` exists to prevent.

**Files:**
- Modify: `desktop/src/features/communities/useCommunityInit.ts`

**Interfaces:**
- Consumes: `resetWorkspaceTabs` (Task 2), `resetChannelSurfaceModes` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Add the imports**

```typescript
import { resetChannelSurfaceModes } from "@/features/workspace/lib/channelSurfaceMode";
import { resetWorkspaceTabs } from "@/features/workspace/lib/workspaceTabs";
```

- [ ] **Step 2: Call them inside `resetCommunityState()`**

Add beside the other resets:

```typescript
resetWorkspaceTabs();
resetChannelSurfaceModes();
```

- [ ] **Step 3: Update the CLAUDE.md singleton list**

In `CLAUDE.md`, under "Current singletons that are reset on relay boundary
changes", add:

```markdown
- `resetWorkspaceTabs()` — per-channel workspace tabs
- `resetChannelSurfaceModes()` — per-channel timeline/workspace mode
```

- [ ] **Step 4: Verify**

Run: `cd desktop && pnpm check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/communities/useCommunityInit.ts CLAUDE.md
git commit -s -m "feat(workspace): reset workspace state on community switch"
```

---

## Task 11: E2E screenshot spec

**Files:**
- Create: `desktop/tests/e2e/channel-workspace.spec.ts`
- Modify: `desktop/playwright.config.ts` (`smoke` project `testMatch`)

**Interfaces:**
- Consumes: the `data-testid` values from Tasks 5, 6, and 9.
- Produces: four distinct screenshots for the PR body.

- [ ] **Step 1: Write the spec**

Create `desktop/tests/e2e/channel-workspace.spec.ts`:

```typescript
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/e2eBridge";

test.describe("channel workspace", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/channels/general");
  });

  test("toggling the workspace replaces the timeline", async ({ page }) => {
    const toggle = page.getByTestId("channel-workspace-toggle");
    await expect(toggle).toBeVisible();

    await expect(page.getByTestId("channel-workspace")).toHaveCount(0);
    await toggle.click();

    const workspace = page.getByTestId("channel-workspace");
    await expect(workspace).toBeVisible();
    await waitForAnimations(page);
    await workspace.screenshot({
      path: "test-results/workspace/01-empty-workspace.png",
    });

    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
  });

  test("creating a scratchpad tab opens a body and a strip entry", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const body = page.getByTestId("workspace-scratchpad-body");
    await expect(body).toBeVisible();
    await body.fill("workspace notes for #general");

    await expect(page.getByTestId("workspace-tab-strip")).toBeVisible();
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/02-scratchpad-tab.png",
    });
  });

  test("two tabs share one strip with no nesting", async ({ page }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const strips = page.getByTestId("workspace-tab-strip");
    await expect(strips).toHaveCount(1, "there is exactly one tab strip");
    await expect(page.getByRole("tab")).toHaveCount(2);

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/03-two-tabs.png",
    });
  });

  test("the workspace survives leaving and returning to the channel", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-scratchpad-body").fill("kept");

    await page.goto("/channels/random");
    await expect(page.getByTestId("channel-workspace")).toHaveCount(
      0,
      "workspace mode is per channel, so #random opens on its timeline",
    );

    await page.goto("/channels/general");
    await expect(page.getByTestId("workspace-scratchpad-body")).toHaveValue(
      "kept",
    );
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/04-restored.png",
    });
  });
});
```

- [ ] **Step 2: Register the spec**

In `desktop/playwright.config.ts`, add `channel-workspace.spec.ts` to the
`smoke` project's `testMatch` list.

- [ ] **Step 3: Run the spec**

Run: `cd desktop && pnpm test:e2e:smoke`

Do NOT run `pnpm run build` then `playwright test` by hand: a plain build strips
the mock Tauri bridge and every spec fails with
`Cannot read properties of undefined (reading 'invoke')`, which looks like a
product bug rather than a build mistake. If a previous build's server is still
on port 4173, kill it first.

Expected: PASS (4 tests).

- [ ] **Step 4: Verify the screenshots are actually distinct**

```bash
shasum -a 256 test-results/workspace/*.png
```

Every hash must be unique. Identical hashes mean two shots captured the same
state: fix the spec, do not post them.

- [ ] **Step 5: Commit**

```bash
git add desktop/tests/e2e/channel-workspace.spec.ts desktop/playwright.config.ts
git commit -s -m "test(workspace): e2e coverage for the channel workspace"
```

---

## Task 12: Full gate and PR

- [ ] **Step 1: Run the whole local gate**

```bash
just ci
```

Expected: fmt, clippy, desktop lint, unit tests, and builds all pass.

- [ ] **Step 2: Post the screenshots**

```bash
./scripts/post-screenshots.sh <PR-number> test-results/workspace
```

Never use `buzz upload` or a relay media URL: those fail through GitHub's camo
proxy.

- [ ] **Step 3: Open the PR and arm auto-merge**

```bash
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(workspace): channel workspace phase A" --body-file <body>
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

`--auto` is not optional: plain `gh pr merge` is refused on `develop`, because
the merge queue owns the strategy.

---

## Self-review

**Spec coverage.** Content column takeover: Task 6. Per-channel mode memory:
Task 1. Workspace header toggle: Task 6. Right pane untouched: Task 6 Step 2
leaves `RightAuxiliaryPane` alone. Threads forced to split: Task 7. Expand
control: Tasks 1 and 5. One tab strip, one level: Task 5, asserted in Task 11.
Tab model separate from kind model: Task 2, asserted by the opaque-payload test.
Kind-agnostic contract proven by a stub kind not shipped in UI: Task 3. Tabs
never shared across channels: Task 2. Lazy state creation: the file and image
kinds read nothing until a path is set (Task 9). Restore on reopen: Task 2
persistence plus the Task 11 restore test. New-tab empty state: Task 5.
Community teardown: Task 10.

**Deliberately not covered, and tracked in "Out of scope":** agent ownership and
grants, approvals and evidence, ledger wiring, the `web`, `terminal`, and
`video` kinds, and the "Open in workspace" affordance on thread links. Each
needs the tab contract from Tasks 2 and 3 to exist first.

**Type consistency.** `WorkspaceTab` fields are identical in Tasks 2, 4, 5, and
9. `TabBodyProps` is defined once in `scratchpadKind.tsx` and imported by
`fileKind.tsx`, `imageKind.tsx`, and `index.tsx`. `TabKindDefinition` fields
match between Task 3 and every kind. `WorkspaceFile` fields match between the
Rust struct in Task 8 and the TypeScript types in Task 9, snake_case included
(`bytes_base64`).
