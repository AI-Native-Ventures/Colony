import {
  emit,
  getNativeBridge,
  setNativeBridge,
  type NativeBridge,
} from "@/shared/api/nativeBridge";

type WebCommand = {
  command: string;
  payload: unknown;
  completedAtMs?: number;
};

type WebPerformanceControls = {
  emitFrameBurst: (count: number) => Promise<void>;
  setWheelDelay: (delayMs: number) => void;
};

type MockWebSession = {
  sessionId: string;
  targetId: string;
  url: string;
};

declare global {
  interface Window {
    __BUZZ_E2E_WEB_COMMANDS__?: () => WebCommand[];
    __BUZZ_E2E_WEB_PERFORMANCE__?: WebPerformanceControls;
  }
}

const sessions = new Map<string, MockWebSession>();
const commands: WebCommand[] = [];
let sequence = 0;
let installed = false;
let wheelDelayMs = 0;
let wheelTail: Promise<void> = Promise.resolve();

// This is a tiny valid image fixture for frontend wiring tests only. Real
// desktop frames come from Page.startScreencast through buzz-browser.
const MOCK_WEB_FRAME_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function reset(): void {
  sessions.clear();
  commands.length = 0;
  sequence = 0;
  wheelDelayMs = 0;
  wheelTail = Promise.resolve();
}

function record(
  command: string,
  payload: unknown,
  completedAtMs?: number,
): void {
  const entry: WebCommand = {
    command,
    payload: structuredClone(payload),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  };
  commands.push(entry);
  window.__BUZZ_E2E_COMMAND_LOG__?.push(entry);
}

function emitLater(event: string, payload: unknown): void {
  window.setTimeout(() => {
    void emit(event, payload);
  }, 0);
}

function emitFrame(sessionId: string, scrollOffsetY = 0): void {
  emitLater("workspace-web-frame", {
    sessionId,
    data: MOCK_WEB_FRAME_DATA,
    width: 640,
    height: 360,
    deviceScaleFactor: 1,
    offsetTop: 0,
    scrollOffsetX: 0,
    scrollOffsetY,
  });
}

async function emitFrameBurst(count: number): Promise<void> {
  const sessionId = sessions.keys().next().value;
  if (!sessionId) throw new Error("mock web session was not found");
  for (let index = 1; index <= count; index += 1) {
    await emit("workspace-web-frame", {
      sessionId,
      data: MOCK_WEB_FRAME_DATA,
      width: 640,
      height: 360,
      deviceScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 0,
      scrollOffsetY: index,
    });
  }
}

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

async function invokeWeb(
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "workspace_web_start": {
      record(command, payload);
      const request = ((payload.request as unknown) ?? payload) as {
        targetId?: string | null;
        url?: string;
      };
      sequence += 1;
      const session = {
        sessionId: `mock-web-${sequence}`,
        targetId: request.targetId || "mock-target",
        url: request.url || "about:blank",
      };
      sessions.set(session.sessionId, session);
      emitFrame(session.sessionId);
      return { ...session, ownsBrowserProcess: false, browserPid: null };
    }
    case "workspace_web_navigate": {
      record(command, payload);
      const input = payload as { sessionId?: string; url?: string };
      const session = input.sessionId
        ? sessions.get(input.sessionId)
        : undefined;
      if (!session) throw new Error("mock web session was not found");
      session.url = input.url || session.url;
      emitFrame(session.sessionId);
      return null;
    }
    case "workspace_web_resize":
    case "workspace_web_back":
    case "workspace_web_forward":
    case "workspace_web_reload": {
      record(command, payload);
      const input = payload as { sessionId?: string };
      if (!input.sessionId || !sessions.has(input.sessionId)) {
        throw new Error("mock web session was not found");
      }
      emitFrame(input.sessionId);
      return null;
    }
    case "workspace_web_wheel": {
      const input = payload as { sessionId?: string };
      if (!input.sessionId || !sessions.has(input.sessionId)) {
        throw new Error("mock web session was not found");
      }
      await recordWheel(command, payload);
      return null;
    }
    case "workspace_web_mouse":
    case "workspace_web_key":
    case "workspace_web_text": {
      record(command, payload);
      const input = payload as { sessionId?: string };
      if (!input.sessionId || !sessions.has(input.sessionId)) {
        throw new Error("mock web session was not found");
      }
      return null;
    }
    case "workspace_web_close": {
      record(command, payload);
      const input = payload as { sessionId?: string };
      if (input.sessionId) {
        sessions.delete(input.sessionId);
        emitLater("workspace-web-closed", {
          sessionId: input.sessionId,
          error: null,
        });
      }
      return null;
    }
    case "workspace_web_close_all": {
      record(command, payload);
      for (const sessionId of sessions.keys()) {
        emitLater("workspace-web-closed", { sessionId, error: null });
      }
      sessions.clear();
      return null;
    }
    default:
      return undefined;
  }
}

/** Install Web workspace mocks as a focused NativeBridge adapter. */
export function installWebE2eBridge(): void {
  if (installed) return;
  const base = getNativeBridge();
  const bridge = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "invoke") {
        return <T>(command: string, payload?: Record<string, unknown>) => {
          if (command.startsWith("workspace_web_")) {
            return invokeWeb(command, payload ?? {}) as Promise<T>;
          }
          return target.invoke<T>(command, payload);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as NativeBridge;
  setNativeBridge(bridge);
  reset();
  window.__BUZZ_E2E_WEB_COMMANDS__ = () =>
    commands.map((entry) => structuredClone(entry));
  window.__BUZZ_E2E_WEB_PERFORMANCE__ = {
    emitFrameBurst,
    setWheelDelay(delayMs) {
      wheelDelayMs = Math.max(0, delayMs);
    },
  };
  installed = true;
}
