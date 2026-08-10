import {
  emit,
  getNativeBridge,
  setNativeBridge,
  type NativeBridge,
} from "@/shared/api/nativeBridge";

type WebCommand = {
  command: string;
  payload: unknown;
};

type MockWebSession = {
  sessionId: string;
  targetId: string;
  url: string;
};

declare global {
  interface Window {
    __BUZZ_E2E_WEB_COMMANDS__?: () => WebCommand[];
  }
}

const sessions = new Map<string, MockWebSession>();
const commands: WebCommand[] = [];
let sequence = 0;
let installed = false;

// This is a tiny valid image fixture for frontend wiring tests only. Real
// desktop frames come from Page.startScreencast through buzz-browser.
const MOCK_WEB_FRAME_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function reset(): void {
  sessions.clear();
  commands.length = 0;
  sequence = 0;
}

function record(command: string, payload: unknown): void {
  const entry = { command, payload: structuredClone(payload) };
  commands.push(entry);
  window.__BUZZ_E2E_COMMAND_LOG__?.push(entry);
}

function emitLater(event: string, payload: unknown): void {
  window.setTimeout(() => {
    void emit(event, payload);
  }, 0);
}

function emitFrame(sessionId: string): void {
  emitLater("workspace-web-frame", {
    sessionId,
    data: MOCK_WEB_FRAME_DATA,
    width: 640,
    height: 360,
    deviceScaleFactor: 1,
    offsetTop: 0,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  });
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
    case "workspace_web_mouse":
    case "workspace_web_wheel":
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
  installed = true;
}
