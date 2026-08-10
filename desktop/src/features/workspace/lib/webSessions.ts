import { invoke, listen, type NativeUnlisten } from "@/shared/api/nativeBridge";

export type WebFrame = {
  data: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
};

export type WebSessionState = {
  status: "idle" | "connecting" | "running" | "closed" | "error";
  sessionId: string | null;
  targetId: string | null;
  url: string | null;
  ownsBrowserProcess: boolean;
  frame: WebFrame | null;
  error: string | null;
};

export type WebSessionRequest = {
  endpoint: string | null;
  binary?: string | null;
  headless?: boolean;
  targetId: string | null;
  url: string;
};

type WebStartResult = {
  sessionId: string;
  targetId: string;
  url: string;
  ownsBrowserProcess: boolean;
};

type WebFrameEvent = WebFrame & { sessionId: string };
type WebErrorEvent = { sessionId: string; error: string };
type WebClosedEvent = { sessionId: string; error: string | null };

const sessions = new Map<string, WebSessionState>();
const nativeToTab = new Map<string, string>();
const pendingFrames = new Map<string, WebFrame>();
const starts = new Map<string, Promise<void>>();
const startTokens = new Map<string, symbol>();
const listeners = new Map<string, Set<() => void>>();
const tabGenerations = new Map<string, number>();
let nativeListeners: Promise<NativeUnlisten[]> | null = null;
let resetGeneration = 0;

const EMPTY_SESSION: WebSessionState = Object.freeze({
  status: "idle",
  sessionId: null,
  targetId: null,
  url: null,
  ownsBrowserProcess: false,
  frame: null,
  error: null,
});

const emptyState = (): WebSessionState => ({
  status: "idle",
  sessionId: null,
  targetId: null,
  url: null,
  ownsBrowserProcess: false,
  frame: null,
  error: null,
});

function emit(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

function setSession(tabId: string, state: WebSessionState): void {
  sessions.set(tabId, state);
  emit(tabId);
}

function advanceTabGeneration(tabId: string): number {
  const generation = (tabGenerations.get(tabId) ?? 0) + 1;
  tabGenerations.set(tabId, generation);
  return generation;
}

function isCurrentGeneration(
  tabId: string,
  generation: number,
  resetAtStart: number,
): boolean {
  return (
    resetGeneration === resetAtStart &&
    tabGenerations.get(tabId) === generation &&
    sessions.has(tabId)
  );
}

async function ensureNativeListeners(): Promise<void> {
  if (!nativeListeners) {
    nativeListeners = Promise.all([
      listen<WebFrameEvent>("workspace-web-frame", (event) => {
        const tabId = nativeToTab.get(event.payload.sessionId);
        const frame = {
          data: event.payload.data,
          width: event.payload.width,
          height: event.payload.height,
          deviceScaleFactor: event.payload.deviceScaleFactor,
          offsetTop: event.payload.offsetTop,
          scrollOffsetX: event.payload.scrollOffsetX,
          scrollOffsetY: event.payload.scrollOffsetY,
        };
        if (!tabId) {
          pendingFrames.set(event.payload.sessionId, frame);
          return;
        }
        const current = sessions.get(tabId);
        if (!current) return;
        setSession(tabId, { ...current, frame });
      }),
      listen<WebErrorEvent>("workspace-web-error", (event) => {
        const tabId = nativeToTab.get(event.payload.sessionId);
        if (!tabId) return;
        const current = sessions.get(tabId) ?? emptyState();
        setSession(tabId, {
          ...current,
          status: "error",
          error: event.payload.error,
        });
      }),
      listen<WebClosedEvent>("workspace-web-closed", (event) => {
        const tabId = nativeToTab.get(event.payload.sessionId);
        if (!tabId) return;
        const current = sessions.get(tabId);
        if (current) {
          setSession(tabId, {
            ...current,
            status: event.payload.error ? "error" : "closed",
            error: event.payload.error,
          });
        }
        nativeToTab.delete(event.payload.sessionId);
        pendingFrames.delete(event.payload.sessionId);
      }),
    ]);
  }
  await nativeListeners;
}

/** Read runtime-only state for one web tab. */
export function getWebSession(tabId: string): WebSessionState {
  return sessions.get(tabId) ?? EMPTY_SESSION;
}

/** Subscribe a web body without tying the CDP lifetime to its mount. */
export function subscribeWebSession(
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

/** Start one native browser session for a tab. Remounts reuse the session. */
export async function ensureWebSession(
  tabId: string,
  request: WebSessionRequest,
): Promise<void> {
  const current = sessions.get(tabId);
  if (current?.sessionId && current.status === "running") return;
  const existing = starts.get(tabId);
  if (existing) return existing;

  const generation = advanceTabGeneration(tabId);
  const resetAtStart = resetGeneration;
  const startToken = Symbol("web-start");
  startTokens.set(tabId, startToken);
  const start = (async () => {
    setSession(tabId, {
      ...(current ?? emptyState()),
      status: "connecting",
      error: null,
    });
    try {
      await ensureNativeListeners();
      const result = await invoke<WebStartResult>("workspace_web_start", {
        request,
      });
      if (!isCurrentGeneration(tabId, generation, resetAtStart)) {
        await invoke("workspace_web_close", {
          sessionId: result.sessionId,
        }).catch(() => undefined);
        pendingFrames.delete(result.sessionId);
        return;
      }
      nativeToTab.set(result.sessionId, tabId);
      const frame = pendingFrames.get(result.sessionId) ?? null;
      pendingFrames.delete(result.sessionId);
      setSession(tabId, {
        status: "running",
        sessionId: result.sessionId,
        targetId: result.targetId,
        url: result.url,
        ownsBrowserProcess: result.ownsBrowserProcess,
        frame,
        error: null,
      });
    } catch (cause: unknown) {
      if (!isCurrentGeneration(tabId, generation, resetAtStart)) return;
      setSession(tabId, {
        ...(sessions.get(tabId) ?? emptyState()),
        status: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      if (startTokens.get(tabId) === startToken) {
        startTokens.delete(tabId);
        starts.delete(tabId);
      }
    }
  })();
  starts.set(tabId, start);
  return start;
}

/** Navigate the currently attached page. */
export async function navigateWeb(tabId: string, url: string): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  try {
    await invoke("workspace_web_navigate", { sessionId, url });
    const current = sessions.get(tabId);
    if (current) setSession(tabId, { ...current, url, error: null });
  } catch (cause: unknown) {
    const current = sessions.get(tabId) ?? emptyState();
    setSession(tabId, {
      ...current,
      status: "error",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Forward a pointer event to the active CDP page. */
export async function sendWebMouse(
  tabId: string,
  input: {
    eventType: "mouseMoved" | "mousePressed" | "mouseReleased";
    x: number;
    y: number;
    button?: string;
    clickCount?: number;
  },
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke("workspace_web_mouse", { sessionId, input });
}

/** Forward a wheel event to the active CDP page. */
export async function sendWebWheel(
  tabId: string,
  input: { x: number; y: number; deltaX: number; deltaY: number },
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke("workspace_web_wheel", { sessionId, input });
}

/** Forward keydown/keyup and optional printable text to the active page. */
export async function sendWebKey(
  tabId: string,
  input: {
    eventType: "keyDown" | "keyUp";
    key: string;
    code?: string;
    text?: string;
    modifiers?: number;
    windowsVirtualKeyCode?: number;
  },
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke("workspace_web_key", { sessionId, input });
}

/** Forward text through CDP's insertText operation. */
export async function sendWebText(tabId: string, text: string): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke("workspace_web_text", { sessionId, text });
}

/** Close one native web session before removing its tab. */
export async function disposeWebSession(tabId: string): Promise<void> {
  advanceTabGeneration(tabId);
  const session = sessions.get(tabId);
  if (session?.sessionId) {
    try {
      await invoke("workspace_web_close", { sessionId: session.sessionId });
    } finally {
      nativeToTab.delete(session.sessionId);
      pendingFrames.delete(session.sessionId);
    }
  }
  sessions.delete(tabId);
  emit(tabId);
}

/** Drain every native web session at a community boundary. */
export async function resetWebSessions(): Promise<void> {
  resetGeneration += 1;
  let failure: unknown = null;
  try {
    await invoke("workspace_web_close_all");
  } catch (cause: unknown) {
    failure = cause;
  } finally {
    sessions.clear();
    nativeToTab.clear();
    pendingFrames.clear();
    startTokens.clear();
    starts.clear();
    for (const tabId of listeners.keys()) emit(tabId);
  }
  if (failure) throw failure;
}
