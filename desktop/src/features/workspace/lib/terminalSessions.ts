import type { NativeUnlisten } from "@/shared/api/nativeBridge";
import {
  selectTerminalBackend,
  type TerminalBackend,
  type TerminalChunk,
  type TerminalStartRequest,
} from "./terminalBackend";

export type { TerminalChunk, TerminalStartRequest };

export type TerminalSessionState = {
  status: "starting" | "running" | "exited" | "error";
  sessionId: string | null;
  cwd: string | null;
  pid: number | null;
  error: string | null;
};

/**
 * Output never lands in React state: bytes go straight to xterm through
 * `subscribeTerminalOutput`. What is kept here is a replay ring, so a chunk
 * that arrives before a body mounts is not lost and a remount repaints.
 */
const MAX_REPLAY_BYTES = 1024 * 1024;
const SESSION_KEY_PREFIX = "colony.terminal.session.";

const sessions = new Map<string, TerminalSessionState>();
const nativeToTab = new Map<string, string>();
const pendingOutput = new Map<string, TerminalChunk[]>();
type PendingStart = {
  lifecycleEpoch: number;
  tabEpoch: number;
  promise: Promise<void>;
};

type ReplayBuffer = { chunks: TerminalChunk[]; bytes: number };

/**
 * The pane size the renderer last fitted to, per tab. A terminal body fits
 * itself as soon as it mounts, which is normally before the native session
 * exists, so the size is recorded here and replayed the moment the session
 * starts rather than dropped.
 */
const desiredSizes = new Map<string, { cols: number; rows: number }>();

const starts = new Map<string, PendingStart>();
const tabEpochs = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const outputListeners = new Map<string, Set<(chunk: TerminalChunk) => void>>();
const replay = new Map<string, ReplayBuffer>();
let nativeListeners: Promise<NativeUnlisten> | null = null;
let subscribedBackend: TerminalBackend | null = null;
let lifecycleEpoch = 0;
let resetInFlight: Promise<void> | null = null;

const EMPTY_SESSION: TerminalSessionState = Object.freeze({
  status: "starting",
  sessionId: null,
  cwd: null,
  pid: null,
  error: null,
});

const emptyState = (): TerminalSessionState => ({
  status: "starting",
  sessionId: null,
  cwd: null,
  pid: null,
  error: null,
});

function backend() {
  return selectTerminalBackend();
}

function chunkLength(chunk: TerminalChunk): number {
  return typeof chunk === "string" ? chunk.length : chunk.byteLength;
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // A hardened webview may refuse storage access; reattach is then optional.
    return null;
  }
}

function rememberSession(tabId: string, sessionId: string): void {
  try {
    sessionStore()?.setItem(`${SESSION_KEY_PREFIX}${tabId}`, sessionId);
  } catch {
    // Quota or privacy mode: the session simply will not be reattached.
  }
}

function forgetSession(tabId: string): void {
  try {
    sessionStore()?.removeItem(`${SESSION_KEY_PREFIX}${tabId}`);
  } catch {
    // Same as above: losing the hint only costs a reattach.
  }
}

function rememberedSession(tabId: string): string | null {
  try {
    return sessionStore()?.getItem(`${SESSION_KEY_PREFIX}${tabId}`) ?? null;
  } catch {
    return null;
  }
}

function forgetEverySession(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(SESSION_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing to clean up if the store is unavailable.
  }
}

function emit(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

function deliverOutput(tabId: string, chunk: TerminalChunk): void {
  if (chunkLength(chunk) === 0) return;
  const buffer = replay.get(tabId) ?? { chunks: [], bytes: 0 };
  buffer.chunks.push(chunk);
  buffer.bytes += chunkLength(chunk);
  while (buffer.bytes > MAX_REPLAY_BYTES && buffer.chunks.length > 1) {
    const dropped = buffer.chunks.shift();
    if (dropped) buffer.bytes -= chunkLength(dropped);
  }
  replay.set(tabId, buffer);
  for (const listener of outputListeners.get(tabId) ?? []) listener(chunk);
}

async function ensureNativeListeners(): Promise<void> {
  const current = backend();
  // One subscription per host. The host only ever changes under a test that
  // injects a different one, so the swap drops the previous subscription.
  if (subscribedBackend !== current) {
    const previous = nativeListeners;
    subscribedBackend = current;
    nativeListeners = current.subscribe({
      onData: (sessionId, chunk) => {
        const tabId = nativeToTab.get(sessionId);
        if (!tabId) {
          const queued = pendingOutput.get(sessionId) ?? [];
          queued.push(chunk);
          pendingOutput.set(sessionId, queued);
          return;
        }
        deliverOutput(tabId, chunk);
      },
      onExit: (sessionId, info) => {
        const tabId = nativeToTab.get(sessionId);
        if (!tabId) return;
        const current = sessions.get(tabId);
        if (!current) return;
        sessions.set(tabId, {
          ...current,
          status: "exited",
          error:
            info.signal && info.signal !== "SIGHUP"
              ? `Terminal exited with ${info.signal}`
              : null,
        });
        emit(tabId);
      },
    });
    if (previous) {
      void previous.then((remove) => remove()).catch(() => {});
    }
  }
  await nativeListeners;
}

/** Read a tab's runtime-only session state. */
export function getTerminalSession(tabId: string): TerminalSessionState {
  return sessions.get(tabId) ?? EMPTY_SESSION;
}

/** Subscribe a terminal body without tying the PTY lifetime to its mount. */
export function subscribeTerminalSession(
  tabId: string,
  listener: () => void,
): () => void {
  const tabListeners = listeners.get(tabId) ?? new Set<() => void>();
  tabListeners.add(listener);
  listeners.set(tabId, tabListeners);
  return () => {
    tabListeners.delete(listener);
    if (tabListeners.size === 0) listeners.delete(tabId);
  };
}

/**
 * Stream a tab's PTY output. Whatever arrived before this listener existed is
 * replayed first, in order, so a late mount still shows the shell prompt.
 */
export function subscribeTerminalOutput(
  tabId: string,
  listener: (chunk: TerminalChunk) => void,
): () => void {
  const tabListeners =
    outputListeners.get(tabId) ?? new Set<(chunk: TerminalChunk) => void>();
  tabListeners.add(listener);
  outputListeners.set(tabId, tabListeners);
  for (const chunk of replay.get(tabId)?.chunks ?? []) listener(chunk);
  return () => {
    tabListeners.delete(listener);
    if (tabListeners.size === 0) outputListeners.delete(tabId);
  };
}

/** Report rendered bytes so the host can release its backpressure. */
export async function ackTerminalOutput(
  tabId: string,
  bytes: number,
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId || bytes <= 0) return;
  try {
    await backend().ack(sessionId, bytes);
  } catch {
    // A closed session cannot be acked; the PTY is already gone.
  }
}

function nextTabEpoch(tabId: string): number {
  const epoch = (tabEpochs.get(tabId) ?? 0) + 1;
  tabEpochs.set(tabId, epoch);
  return epoch;
}

function isCurrentStart(tabId: string, pending: PendingStart): boolean {
  return (
    lifecycleEpoch === pending.lifecycleEpoch &&
    tabEpochs.get(tabId) === pending.tabEpoch &&
    starts.get(tabId) === pending
  );
}

async function closeLateNativeSession(sessionId: string): Promise<void> {
  try {
    await backend().close(sessionId);
  } catch {
    // A concurrent close_all may have already reaped this stale session.
  }
  pendingOutput.delete(sessionId);
}

function adoptSession(
  tabId: string,
  session: { sessionId: string; cwd: string; pid: number | null },
): void {
  nativeToTab.set(session.sessionId, tabId);
  rememberSession(tabId, session.sessionId);
  sessions.set(tabId, {
    ...(sessions.get(tabId) ?? emptyState()),
    status: "running",
    sessionId: session.sessionId,
    cwd: session.cwd,
    pid: session.pid,
    error: null,
  });
  const pending = pendingOutput.get(session.sessionId);
  if (pending) {
    pendingOutput.delete(session.sessionId);
    emit(tabId);
    for (const chunk of pending) deliverOutput(tabId, chunk);
  } else {
    emit(tabId);
  }
}

/**
 * Push the pane size the renderer already fitted to onto a session that has
 * only just reached "running". `startedWith` is the size the session was
 * created with, so an already-correct PTY is not resized twice; a reattached
 * session has no such size and is always squared with the pane.
 */
async function applyDesiredSize(
  tabId: string,
  startedWith: { cols: number; rows: number } | null,
): Promise<void> {
  const desired = desiredSizes.get(tabId);
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!desired || !sessionId) return;
  if (
    startedWith &&
    startedWith.cols === desired.cols &&
    startedWith.rows === desired.rows
  ) {
    return;
  }
  try {
    await backend().resize(sessionId, desired.cols, desired.rows, 0, 0);
  } catch {
    // A session that died between adopt and resize cannot be resized.
  }
}

/**
 * Pick a shell back up after a renderer reload. Electron keeps the PTY in its
 * main process, so a remembered id that is still alive is reattached and its
 * ring buffer replayed instead of starting a second shell.
 */
async function reattachRememberedSession(
  tabId: string,
  pendingStart: PendingStart,
): Promise<boolean> {
  const sessionId = rememberedSession(tabId);
  if (!sessionId) return false;
  try {
    const live = (await backend().list()).find(
      (candidate) => candidate.sessionId === sessionId && candidate.alive,
    );
    if (!live) {
      forgetSession(tabId);
      return false;
    }
    const { replay: buffer } = await backend().attach(sessionId);
    if (!isCurrentStart(tabId, pendingStart)) return true;
    adoptSession(tabId, {
      sessionId,
      cwd: live.cwd,
      pid: live.pid ?? null,
    });
    if (buffer && buffer.byteLength > 0) deliverOutput(tabId, buffer);
    await applyDesiredSize(tabId, null);
    return true;
  } catch {
    forgetSession(tabId);
    return false;
  }
}

/** Start the native session once for a tab; remounts reuse the same PTY. */
export async function ensureTerminalSession(
  tabId: string,
  request: TerminalStartRequest,
): Promise<void> {
  const callerLifecycleEpoch = lifecycleEpoch;
  const callerTabEpoch = tabEpochs.get(tabId) ?? 0;
  const reset = resetInFlight;
  if (reset) {
    await reset;
    if (
      lifecycleEpoch !== callerLifecycleEpoch ||
      tabEpochs.get(tabId) !== callerTabEpoch
    ) {
      return;
    }
    return;
  }
  const current = sessions.get(tabId);
  if (current?.sessionId && current.status === "running") return;
  const existing = starts.get(tabId);
  if (existing) {
    await existing.promise;
    if (
      lifecycleEpoch !== callerLifecycleEpoch ||
      tabEpochs.get(tabId) !== callerTabEpoch
    ) {
      return;
    }
    return;
  }

  const pendingStart: PendingStart = {
    lifecycleEpoch,
    tabEpoch: nextTabEpoch(tabId),
    promise: Promise.resolve(),
  };

  const start = (async () => {
    sessions.set(tabId, { ...(current ?? emptyState()), status: "starting" });
    emit(tabId);
    try {
      await ensureNativeListeners();
      if (await reattachRememberedSession(tabId, pendingStart)) return;
      const desired = desiredSizes.get(tabId);
      const startRequest = desired
        ? { ...request, cols: desired.cols, rows: desired.rows }
        : request;
      const result = await backend().start(startRequest);
      if (!isCurrentStart(tabId, pendingStart)) {
        await closeLateNativeSession(result.sessionId);
        return;
      }
      adoptSession(tabId, {
        sessionId: result.sessionId,
        cwd: result.cwd,
        pid: result.pid ?? null,
      });
      await applyDesiredSize(tabId, {
        cols: startRequest.cols,
        rows: startRequest.rows,
      });
    } catch (cause: unknown) {
      if (!isCurrentStart(tabId, pendingStart)) return;
      sessions.set(tabId, {
        ...(sessions.get(tabId) ?? emptyState()),
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
      emit(tabId);
    } finally {
      if (starts.get(tabId) === pendingStart) starts.delete(tabId);
    }
  })();
  pendingStart.promise = start;
  starts.set(tabId, pendingStart);
  return start;
}

/** Send xterm.js keyboard data to the native PTY. */
export async function writeTerminalInput(
  tabId: string,
  data: string,
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  try {
    await backend().write(sessionId, data);
  } catch (cause: unknown) {
    const current = sessions.get(tabId);
    sessions.set(tabId, {
      ...(current ?? emptyState()),
      status: "error",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    emit(tabId);
  }
}

/**
 * Keep the native PTY dimensions aligned with the xterm renderer.
 *
 * The size is always recorded, even with no session yet: the first fit happens
 * while the shell is still being spawned, and the renderer will not repeat a
 * size it has already sent. A recorded size is replayed by
 * `ensureTerminalSession` once the session is running.
 */
export async function resizeTerminal(
  tabId: string,
  cols: number,
  rows: number,
  pixelWidth = 0,
  pixelHeight = 0,
): Promise<void> {
  if (cols < 2 || rows < 2) return;
  desiredSizes.set(tabId, { cols, rows });
  const current = sessions.get(tabId);
  if (!current?.sessionId || current.status !== "running") return;
  await backend().resize(
    current.sessionId,
    cols,
    rows,
    pixelWidth,
    pixelHeight,
  );
}

/** Close one session when its tab is closed. */
export async function disposeTerminalSession(tabId: string): Promise<void> {
  const invalidationEpoch = nextTabEpoch(tabId);
  const session = sessions.get(tabId);
  const pending = starts.get(tabId);
  let failure: unknown = null;
  forgetSession(tabId);
  if (session?.sessionId) {
    try {
      await backend().close(session.sessionId);
    } catch (cause: unknown) {
      failure = cause;
    }
    nativeToTab.delete(session.sessionId);
    pendingOutput.delete(session.sessionId);
  }
  if (pending) {
    try {
      await pending.promise;
    } catch (cause: unknown) {
      failure ??= cause;
    }
  }
  if (tabEpochs.get(tabId) === invalidationEpoch) {
    const lateSession = sessions.get(tabId)?.sessionId;
    if (lateSession && lateSession !== session?.sessionId) {
      try {
        await backend().close(lateSession);
      } catch (cause: unknown) {
        failure ??= cause;
      }
      nativeToTab.delete(lateSession);
      pendingOutput.delete(lateSession);
    }
    sessions.delete(tabId);
    replay.delete(tabId);
    desiredSizes.delete(tabId);
    forgetSession(tabId);
  }
  emit(tabId);
  if (failure) throw failure;
}

/** Drain every native session before a community switch or app reset. */
export function resetTerminalSessions(): Promise<void> {
  if (resetInFlight) return resetInFlight;
  lifecycleEpoch += 1;
  const pending = [...new Set(starts.values())];
  const reset = (async () => {
    let failure: unknown = null;
    try {
      await backend().closeAll();
    } catch (cause: unknown) {
      failure = cause;
    }
    const settled = await Promise.allSettled(
      pending.map((start) => start.promise),
    );
    const lateFailure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    failure ??= lateFailure?.reason ?? null;
    sessions.clear();
    nativeToTab.clear();
    pendingOutput.clear();
    starts.clear();
    tabEpochs.clear();
    replay.clear();
    desiredSizes.clear();
    forgetEverySession();
    for (const tabId of listeners.keys()) emit(tabId);
    if (failure) throw failure;
  })();
  const guarded = reset.finally(() => {
    if (resetInFlight === guarded) resetInFlight = null;
  });
  resetInFlight = guarded;
  return guarded;
}
