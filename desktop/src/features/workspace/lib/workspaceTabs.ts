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
    if (state.activeTabId !== tabId)
      return { tabs, activeTabId: state.activeTabId };
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

/** Show the new-tab page without closing anything. */
export function clearActiveTab(channelId: string): void {
  write(channelId, (state) => ({ ...state, activeTabId: null }));
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
