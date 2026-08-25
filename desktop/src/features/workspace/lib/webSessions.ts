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
  browserPid: number | null;
  frame: WebFrame | null;
  error: string | null;
};

export type WebSessionRequest = {
  endpoint: string | null;
  targetId: string | null;
  url: string;
};

type WebStartResult = {
  sessionId: string;
  targetId: string;
  url: string;
  ownsBrowserProcess: boolean;
  browserPid: number | null;
};

type WebFrameEvent = WebFrame & { sessionId: string };
type WebErrorEvent = { sessionId: string; error: string };
type WebClosedEvent = { sessionId: string; error: string | null };
type WebWheelInput = {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};
type WheelWaiter = {
  reject: (cause: unknown) => void;
  resolve: () => void;
};
type PendingWheel = {
  input: WebWheelInput;
  waiters: WheelWaiter[];
};
type WheelDispatcher = {
  inFlight: boolean;
  pending: PendingWheel | null;
  scheduled: boolean;
};
type NormalizedWebSessionRequest = WebSessionRequest & { url: string };
type WebStartQueue = {
  cancelled: boolean;
  latestKey: string;
  latestRequest: NormalizedWebSessionRequest;
  promise: Promise<void>;
};
type PendingWebFrame = {
  eligibleStarts: Set<symbol>;
  frame: WebFrame;
};

const sessions = new Map<string, WebSessionState>();
const nativeToTab = new Map<string, string>();
const pendingFrames = new Map<string, PendingWebFrame>();
const queuedFrames = new Map<string, WebFrame>();
const starts = new Map<string, WebStartQueue>();
const listeners = new Map<string, Set<() => void>>();
const tabGenerations = new Map<string, number>();
const wheelDispatchers = new Map<string, WheelDispatcher>();
const retiredNativeSessions = new Set<string>();
const activeNativeStarts = new Set<symbol>();
const MAX_RETIRED_NATIVE_SESSIONS = 256;
const MAX_PENDING_FRAMES_PER_START = 4;
const MAX_WEB_URL_BYTES = 8 * 1024;
let nativeListeners: Promise<NativeUnlisten[]> | null = null;
let resetGeneration = 0;
let frameFlushGeneration = 0;
let frameFlushScheduled = false;

const EMPTY_SESSION: WebSessionState = Object.freeze({
  status: "idle",
  sessionId: null,
  targetId: null,
  url: null,
  ownsBrowserProcess: false,
  browserPid: null,
  frame: null,
  error: null,
});

const emptyState = (): WebSessionState => ({
  status: "idle",
  sessionId: null,
  targetId: null,
  url: null,
  ownsBrowserProcess: false,
  browserPid: null,
  frame: null,
  error: null,
});

const INVALID_URL_ERROR =
  "This address cannot be opened. Use http://, https://, or about:blank.";
const START_ERROR =
  "The browser could not be started. Check the connection and try again.";
const RUNTIME_ERROR = "The browser session stopped unexpectedly. Try again.";
const NAVIGATION_ERROR =
  "This page could not be opened. Check the address and try again.";

/** Allow only page URLs that are safe to send across the native boundary. */
export function normalizeWebNavigationUrl(value: string): string | null {
  const candidate = value.trim();
  if (candidate === "about:blank") return candidate;
  if (!candidate) return null;
  let utf8ByteLength = 0;
  for (const character of candidate) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return null;
    utf8ByteLength +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (utf8ByteLength > MAX_WEB_URL_BYTES) return null;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.username || parsed.password) return null;
    return candidate;
  } catch {
    return null;
  }
}

function detachNativeSession(sessionId: string): void {
  nativeToTab.delete(sessionId);
  pendingFrames.delete(sessionId);
  queuedFrames.delete(sessionId);
  retiredNativeSessions.delete(sessionId);
  retiredNativeSessions.add(sessionId);
  while (retiredNativeSessions.size > MAX_RETIRED_NATIVE_SESSIONS) {
    const oldestSessionId = retiredNativeSessions.values().next().value;
    if (typeof oldestSessionId !== "string") break;
    retiredNativeSessions.delete(oldestSessionId);
  }
}

function webSessionRequestKey(request: NormalizedWebSessionRequest): string {
  return JSON.stringify([request.endpoint, request.targetId, request.url]);
}

function trimPendingFrames(): void {
  const limit = activeNativeStarts.size * MAX_PENDING_FRAMES_PER_START;
  while (pendingFrames.size > limit) {
    const oldestSessionId = pendingFrames.keys().next().value;
    if (typeof oldestSessionId !== "string") break;
    pendingFrames.delete(oldestSessionId);
  }
}

function finishNativeStart(startToken: symbol): void {
  activeNativeStarts.delete(startToken);
  for (const [sessionId, pending] of pendingFrames) {
    pending.eligibleStarts.delete(startToken);
    if (pending.eligibleStarts.size === 0) pendingFrames.delete(sessionId);
  }
  trimPendingFrames();
}

function emit(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

function setSession(tabId: string, state: WebSessionState): void {
  sessions.set(tabId, state);
  emit(tabId);
}

function scheduleAnimationFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  queueMicrotask(callback);
}

function flushQueuedFrames(generation: number): void {
  if (generation !== frameFlushGeneration) return;
  frameFlushScheduled = false;
  const frames = [...queuedFrames.entries()];
  queuedFrames.clear();
  for (const [sessionId, frame] of frames) {
    const tabId = nativeToTab.get(sessionId);
    if (!tabId) continue;
    const current = sessions.get(tabId);
    if (!current || current.sessionId !== sessionId) continue;
    setSession(tabId, { ...current, frame });
  }
}

function queueFrame(sessionId: string, frame: WebFrame): void {
  queuedFrames.set(sessionId, frame);
  if (frameFlushScheduled) return;
  frameFlushScheduled = true;
  const generation = frameFlushGeneration;
  scheduleAnimationFrame(() => flushQueuedFrames(generation));
}

function clearQueuedFrames(): void {
  queuedFrames.clear();
  frameFlushGeneration += 1;
  frameFlushScheduled = false;
}

function handleWebFrameEvent(event: WebFrameEvent): void {
  if (retiredNativeSessions.has(event.sessionId)) return;
  const tabId = nativeToTab.get(event.sessionId);
  const frame = {
    data: event.data,
    width: event.width,
    height: event.height,
    deviceScaleFactor: event.deviceScaleFactor,
    offsetTop: event.offsetTop,
    scrollOffsetX: event.scrollOffsetX,
    scrollOffsetY: event.scrollOffsetY,
  };
  if (!tabId) {
    if (activeNativeStarts.size === 0) return;
    const pending = pendingFrames.get(event.sessionId);
    if (pending) {
      pending.frame = frame;
    } else {
      pendingFrames.set(event.sessionId, {
        eligibleStarts: new Set(activeNativeStarts),
        frame,
      });
      trimPendingFrames();
    }
    return;
  }
  queueFrame(event.sessionId, frame);
}

function handleWebErrorEvent(event: WebErrorEvent): void {
  const tabId = nativeToTab.get(event.sessionId);
  if (!tabId) return;
  const current = sessions.get(tabId) ?? emptyState();
  setSession(tabId, {
    ...current,
    status: "error",
    error: RUNTIME_ERROR,
  });
}

function handleWebClosedEvent(event: WebClosedEvent): void {
  const tabId = nativeToTab.get(event.sessionId);
  if (!tabId) return;
  const current = sessions.get(tabId);
  if (current) {
    setSession(tabId, {
      ...current,
      status: event.error ? "error" : "closed",
      error: event.error ? RUNTIME_ERROR : null,
    });
  }
  detachNativeSession(event.sessionId);
}

function getWheelDispatcher(tabId: string): WheelDispatcher {
  const existing = wheelDispatchers.get(tabId);
  if (existing) return existing;
  const dispatcher: WheelDispatcher = {
    inFlight: false,
    pending: null,
    scheduled: false,
  };
  wheelDispatchers.set(tabId, dispatcher);
  return dispatcher;
}

function settlePendingWheel(pending: PendingWheel): void {
  for (const waiter of pending.waiters) waiter.resolve();
}

function clearWheelDispatcher(tabId: string): void {
  const dispatcher = wheelDispatchers.get(tabId);
  wheelDispatchers.delete(tabId);
  if (dispatcher?.pending) settlePendingWheel(dispatcher.pending);
}

function clearWheelDispatchers(): void {
  for (const tabId of wheelDispatchers.keys()) clearWheelDispatcher(tabId);
}

function scheduleWheelFlush(tabId: string, dispatcher: WheelDispatcher): void {
  if (dispatcher.inFlight || dispatcher.scheduled || !dispatcher.pending)
    return;
  dispatcher.scheduled = true;
  queueMicrotask(() => {
    if (wheelDispatchers.get(tabId) !== dispatcher) return;
    dispatcher.scheduled = false;
    void flushWheel(tabId, dispatcher);
  });
}

async function flushWheel(
  tabId: string,
  dispatcher: WheelDispatcher,
): Promise<void> {
  if (dispatcher.inFlight || !dispatcher.pending) return;
  const pending = dispatcher.pending;
  dispatcher.pending = null;
  dispatcher.inFlight = true;
  try {
    const sessionId = sessions.get(tabId)?.sessionId;
    if (sessionId) {
      await invoke("workspace_web_wheel", { sessionId, input: pending.input });
    }
    settlePendingWheel(pending);
  } catch (cause: unknown) {
    for (const waiter of pending.waiters) waiter.reject(cause);
  } finally {
    dispatcher.inFlight = false;
    if (wheelDispatchers.get(tabId) === dispatcher) {
      scheduleWheelFlush(tabId, dispatcher);
    }
  }
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
      listen<WebFrameEvent>("workspace-web-frame", (event) =>
        handleWebFrameEvent(event.payload),
      ),
      listen<WebErrorEvent>("workspace-web-error", (event) =>
        handleWebErrorEvent(event.payload),
      ),
      listen<WebClosedEvent>("workspace-web-closed", (event) =>
        handleWebClosedEvent(event.payload),
      ),
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

async function startWebSession(
  tabId: string,
  request: NormalizedWebSessionRequest,
): Promise<void> {
  const current = sessions.get(tabId);
  const generation = advanceTabGeneration(tabId);
  const resetAtStart = resetGeneration;
  const nativeStartToken = Symbol("native-web-start");
  setSession(tabId, {
    ...(current ?? emptyState()),
    status: "connecting",
    sessionId: null,
    targetId: null,
    ownsBrowserProcess: false,
    browserPid: null,
    frame: null,
    error: null,
  });
  try {
    await ensureNativeListeners();
    if (current?.sessionId) {
      detachNativeSession(current.sessionId);
      clearWheelDispatcher(tabId);
      try {
        await invoke("workspace_web_close", {
          sessionId: current.sessionId,
        });
      } catch {
        if (isCurrentGeneration(tabId, generation, resetAtStart)) {
          setSession(tabId, {
            ...current,
            status: "error",
            error: START_ERROR,
          });
        }
        return;
      }
    }
    activeNativeStarts.add(nativeStartToken);
    const result = await invoke<WebStartResult>("workspace_web_start", {
      // Only endpoint/target/url are user-facing connection inputs. The
      // browser binary and launch mode stay native-owned so a restored tab
      // payload can never execute an arbitrary local path or open a visible
      // focus-stealing browser.
      request: {
        endpoint: request.endpoint,
        targetId: request.targetId,
        url: request.url,
      },
    });
    if (!isCurrentGeneration(tabId, generation, resetAtStart)) {
      await invoke("workspace_web_close", {
        sessionId: result.sessionId,
      }).catch(() => undefined);
      detachNativeSession(result.sessionId);
      return;
    }
    retiredNativeSessions.delete(result.sessionId);
    nativeToTab.set(result.sessionId, tabId);
    const frame = pendingFrames.get(result.sessionId)?.frame ?? null;
    pendingFrames.delete(result.sessionId);
    setSession(tabId, {
      status: "running",
      sessionId: result.sessionId,
      targetId: result.targetId,
      url: result.url,
      ownsBrowserProcess: result.ownsBrowserProcess,
      browserPid: result.browserPid,
      frame,
      error: null,
    });
  } catch {
    if (!isCurrentGeneration(tabId, generation, resetAtStart)) return;
    setSession(tabId, {
      ...(sessions.get(tabId) ?? emptyState()),
      status: "error",
      error: START_ERROR,
    });
  } finally {
    finishNativeStart(nativeStartToken);
  }
}

async function drainWebStartQueue(
  tabId: string,
  queue: WebStartQueue,
): Promise<void> {
  try {
    while (!queue.cancelled) {
      const request = queue.latestRequest;
      const requestKey = queue.latestKey;
      await startWebSession(tabId, request);
      if (queue.cancelled || starts.get(tabId) !== queue) return;
      if (queue.latestKey === requestKey) return;
    }
  } finally {
    if (starts.get(tabId) === queue) starts.delete(tabId);
  }
}

/** Start one native browser session for a tab. Remounts reuse the session. */
export async function ensureWebSession(
  tabId: string,
  request: WebSessionRequest,
): Promise<void> {
  const current = sessions.get(tabId);
  if (current?.sessionId && current.status === "running") return;

  const normalizedUrl = normalizeWebNavigationUrl(request.url);
  if (!normalizedUrl) {
    setSession(tabId, {
      ...(current ?? emptyState()),
      status: "error",
      error: INVALID_URL_ERROR,
    });
    return;
  }
  const normalizedRequest = { ...request, url: normalizedUrl };
  const requestKey = webSessionRequestKey(normalizedRequest);
  const existing = starts.get(tabId);
  if (existing) {
    if (existing.latestKey !== requestKey) {
      existing.latestKey = requestKey;
      existing.latestRequest = normalizedRequest;
    }
    return existing.promise;
  }

  const queue: WebStartQueue = {
    cancelled: false,
    latestKey: requestKey,
    latestRequest: normalizedRequest,
    promise: Promise.resolve(),
  };
  queue.promise = drainWebStartQueue(tabId, queue);
  starts.set(tabId, queue);
  return queue.promise;
}

/** Navigate the currently attached page. */
export async function navigateWeb(tabId: string, url: string): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  const normalizedUrl = normalizeWebNavigationUrl(url);
  if (!normalizedUrl) {
    const current = sessions.get(tabId) ?? emptyState();
    setSession(tabId, {
      ...current,
      status: "error",
      error: INVALID_URL_ERROR,
    });
    return;
  }
  try {
    await invoke("workspace_web_navigate", { sessionId, url: normalizedUrl });
    const current = sessions.get(tabId);
    if (current)
      setSession(tabId, { ...current, url: normalizedUrl, error: null });
  } catch {
    const current = sessions.get(tabId) ?? emptyState();
    setSession(tabId, {
      ...current,
      status: "error",
      error: NAVIGATION_ERROR,
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
  input: WebWheelInput,
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  const dispatcher = getWheelDispatcher(tabId);
  return new Promise<void>((resolve, reject) => {
    const waiter = { reject, resolve };
    if (dispatcher.pending) {
      dispatcher.pending.input = {
        x: input.x,
        y: input.y,
        deltaX: dispatcher.pending.input.deltaX + input.deltaX,
        deltaY: dispatcher.pending.input.deltaY + input.deltaY,
      };
      dispatcher.pending.waiters.push(waiter);
    } else {
      dispatcher.pending = { input: { ...input }, waiters: [waiter] };
    }
    scheduleWheelFlush(tabId, dispatcher);
  });
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

async function invokeWebSession(tabId: string, command: string): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke(command, { sessionId });
}

/** Resize the CDP viewport to the visible browser surface. */
export async function resizeWeb(
  tabId: string,
  width: number,
  height: number,
  deviceScaleFactor: number,
): Promise<void> {
  const sessionId = sessions.get(tabId)?.sessionId;
  if (!sessionId) return;
  await invoke("workspace_web_resize", {
    sessionId,
    width,
    height,
    deviceScaleFactor,
  });
}

/** Navigate backward in the current page history. */
export const goBackWeb = (tabId: string): Promise<void> =>
  invokeWebSession(tabId, "workspace_web_back");

/** Navigate forward in the current page history. */
export const goForwardWeb = (tabId: string): Promise<void> =>
  invokeWebSession(tabId, "workspace_web_forward");

/** Reload the active page. */
export const reloadWeb = (tabId: string): Promise<void> =>
  invokeWebSession(tabId, "workspace_web_reload");

/** Close one native web session before removing its tab. */
export async function disposeWebSession(tabId: string): Promise<void> {
  const pendingQueue = starts.get(tabId);
  if (pendingQueue) pendingQueue.cancelled = true;
  advanceTabGeneration(tabId);
  clearWheelDispatcher(tabId);
  const session = sessions.get(tabId);
  let failure: unknown = null;
  if (session?.sessionId) {
    try {
      await invoke("workspace_web_close", { sessionId: session.sessionId });
    } catch (cause: unknown) {
      failure = cause;
    } finally {
      detachNativeSession(session.sessionId);
    }
  }
  if (pendingQueue) {
    try {
      await pendingQueue.promise;
    } catch (cause: unknown) {
      failure ??= cause;
    }
  }
  sessions.delete(tabId);
  emit(tabId);
  if (failure) throw failure;
}

/** Drain every native web session at a community boundary. */
export async function resetWebSessions(): Promise<void> {
  resetGeneration += 1;
  clearWheelDispatchers();
  clearQueuedFrames();
  const pendingQueues = [...starts.values()];
  for (const queue of pendingQueues) queue.cancelled = true;
  let failure: unknown = null;
  try {
    await invoke("workspace_web_close_all");
  } catch (cause: unknown) {
    failure = cause;
  } finally {
    sessions.clear();
    nativeToTab.clear();
    pendingFrames.clear();
    await Promise.allSettled(pendingQueues.map((queue) => queue.promise));
    starts.clear();
    for (const tabId of listeners.keys()) emit(tabId);
  }
  if (failure) throw failure;
}

/** Drive the native lifecycle handlers without exposing a production event seam. */
export function applyWebSessionEventForTest(
  event:
    | { type: "frame"; payload: WebFrameEvent }
    | { type: "error"; payload: WebErrorEvent }
    | { type: "closed"; payload: WebClosedEvent },
): void {
  if (event.type === "frame") {
    handleWebFrameEvent(event.payload);
    return;
  }
  if (event.type === "error") {
    handleWebErrorEvent(event.payload);
    return;
  }
  handleWebClosedEvent(event.payload);
}

/** Report bounded stale-session bookkeeping for lifecycle regression tests. */
export function retiredWebSessionCountForTest(): number {
  return retiredNativeSessions.size;
}

/** Report bounded pre-start frame bookkeeping for lifecycle regression tests. */
export function pendingWebFrameCountForTest(): number {
  return pendingFrames.size;
}
