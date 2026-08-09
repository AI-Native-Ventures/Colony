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
