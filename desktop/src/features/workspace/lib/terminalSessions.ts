import { invoke, listen, type NativeUnlisten } from "@/shared/api/nativeBridge";

type TerminalOutputEvent = {
  sessionId: string;
  data: string;
};

type TerminalExitEvent = {
  sessionId: string;
  code?: number | null;
  signal?: string | null;
};

export type TerminalSessionState = {
  status: "starting" | "running" | "exited" | "error";
  sessionId: string | null;
  cwd: string | null;
  pid: number | null;
  output: string;
  error: string | null;
};

export type TerminalStartRequest = {
  channelId: string;
  projectDtag: string | null;
  cloneUrl: string | null;
  reposDir: string | null;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

type TerminalStartResult = {
  sessionId: string;
  cwd: string;
  pid: number | null;
};

const MAX_OUTPUT_CHARS = 256 * 1024;
const sessions = new Map<string, TerminalSessionState>();
const nativeToTab = new Map<string, string>();
const pendingOutput = new Map<string, string>();
type PendingStart = {
  lifecycleEpoch: number;
  tabEpoch: number;
  promise: Promise<void>;
};

const starts = new Map<string, PendingStart>();
const tabEpochs = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
let nativeListeners: Promise<NativeUnlisten[]> | null = null;
let lifecycleEpoch = 0;
let resetInFlight: Promise<void> | null = null;

const EMPTY_SESSION: TerminalSessionState = Object.freeze({
  status: "starting",
  sessionId: null,
  cwd: null,
  pid: null,
  output: "",
  error: null,
});

const emptyState = (): TerminalSessionState => ({
  status: "starting",
  sessionId: null,
  cwd: null,
  pid: null,
  output: "",
  error: null,
});

function emit(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

function appendOutput(tabId: string, data: string): void {
  const current = sessions.get(tabId) ?? emptyState();
  const output = `${current.output}${data}`;
  sessions.set(tabId, {
    ...current,
    output:
      output.length > MAX_OUTPUT_CHARS
        ? output.slice(output.length - MAX_OUTPUT_CHARS)
        : output,
  });
  emit(tabId);
}

async function ensureNativeListeners(): Promise<void> {
  if (!nativeListeners) {
    nativeListeners = Promise.all([
      listen<TerminalOutputEvent>("workspace-terminal-output", (event) => {
        const tabId = nativeToTab.get(event.payload.sessionId);
        if (!tabId) {
          const prior = pendingOutput.get(event.payload.sessionId) ?? "";
          pendingOutput.set(
            event.payload.sessionId,
            `${prior}${event.payload.data}`,
          );
          return;
        }
        appendOutput(tabId, event.payload.data);
      }),
      listen<TerminalExitEvent>("workspace-terminal-exit", (event) => {
        const tabId = nativeToTab.get(event.payload.sessionId);
        if (!tabId) return;
        const current = sessions.get(tabId);
        if (!current) return;
        sessions.set(tabId, {
          ...current,
          status: "exited",
          error:
            event.payload.signal && event.payload.signal !== "SIGHUP"
              ? `Terminal exited with ${event.payload.signal}`
              : null,
        });
        emit(tabId);
      }),
    ]);
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
    await invoke("workspace_terminal_close", { sessionId });
  } catch {
    // A concurrent close_all may have already reaped this stale session.
  }
  pendingOutput.delete(sessionId);
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
      const result = await invoke<TerminalStartResult>(
        "workspace_terminal_start",
        { request },
      );
      if (!isCurrentStart(tabId, pendingStart)) {
        await closeLateNativeSession(result.sessionId);
        return;
      }
      nativeToTab.set(result.sessionId, tabId);
      sessions.set(tabId, {
        ...(sessions.get(tabId) ?? emptyState()),
        status: "running",
        sessionId: result.sessionId,
        cwd: result.cwd,
        pid: result.pid ?? null,
        error: null,
      });
      const pending = pendingOutput.get(result.sessionId);
      if (pending) {
        pendingOutput.delete(result.sessionId);
        appendOutput(tabId, pending);
      } else {
        emit(tabId);
      }
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
    await invoke("workspace_terminal_write", { sessionId, data });
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

/** Keep the native PTY dimensions aligned with the xterm renderer. */
export async function resizeTerminal(
  tabId: string,
  cols: number,
  rows: number,
  pixelWidth = 0,
  pixelHeight = 0,
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId || cols < 2 || rows < 2) return;
  await invoke("workspace_terminal_resize", {
    sessionId,
    cols,
    rows,
    pixelWidth,
    pixelHeight,
  });
}

/** Close one session when its tab is closed. */
export async function disposeTerminalSession(tabId: string): Promise<void> {
  const invalidationEpoch = nextTabEpoch(tabId);
  const session = sessions.get(tabId);
  const pending = starts.get(tabId);
  let failure: unknown = null;
  if (session?.sessionId) {
    try {
      await invoke("workspace_terminal_close", {
        sessionId: session.sessionId,
      });
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
        await invoke("workspace_terminal_close", { sessionId: lateSession });
      } catch (cause: unknown) {
        failure ??= cause;
      }
      nativeToTab.delete(lateSession);
      pendingOutput.delete(lateSession);
    }
    sessions.delete(tabId);
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
      await invoke("workspace_terminal_close_all");
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
    for (const tabId of listeners.keys()) emit(tabId);
    if (failure) throw failure;
  })();
  const guarded = reset.finally(() => {
    if (resetInFlight === guarded) resetInFlight = null;
  });
  resetInFlight = guarded;
  return guarded;
}
