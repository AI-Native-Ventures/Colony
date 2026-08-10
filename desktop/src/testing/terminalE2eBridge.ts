import {
  emit,
  getNativeBridge,
  setNativeBridge,
  type NativeBridge,
} from "@/shared/api/nativeBridge";

type TerminalCommand = {
  command: string;
  payload: unknown;
};

type MockTerminalSession = {
  sessionId: string;
  cwd: string;
  pid: number;
};

declare global {
  interface Window {
    __BUZZ_E2E_TERMINAL_MOCK__?: boolean;
    __BUZZ_E2E_TERMINAL_COMMANDS__?: () => TerminalCommand[];
    __BUZZ_E2E_RESET_TERMINAL_MOCK__?: () => void;
  }
}

const sessions = new Map<string, MockTerminalSession>();
const commands: TerminalCommand[] = [];
let sequence = 0;
let installed = false;

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

async function invokeTerminal(
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  switch (command) {
    case "workspace_terminal_start": {
      const input = ((payload.request as unknown) ?? payload) as {
        projectDtag?: string | null;
        reposDir?: string | null;
      };
      sequence += 1;
      const session = {
        sessionId: `mock-terminal-${sequence}`,
        cwd: input.projectDtag
          ? `${input.reposDir ?? "/tmp/buzz/REPOS"}/${input.projectDtag}`
          : "/Users/mock",
        pid: 40_000 + sequence,
      };
      sessions.set(session.sessionId, session);
      record(command, payload);
      emitLater("workspace-terminal-output", {
        sessionId: session.sessionId,
        data: "$ ",
      });
      return session;
    }
    case "workspace_terminal_write": {
      const input = payload as { sessionId?: string; data?: string };
      const session = input.sessionId
        ? sessions.get(input.sessionId)
        : undefined;
      if (!session) throw new Error("mock terminal session was not found");
      record(command, payload);
      emitLater("workspace-terminal-output", {
        sessionId: session.sessionId,
        data: `mock-output:${input.data ?? ""}`,
      });
      return null;
    }
    case "workspace_terminal_resize":
      record(command, payload);
      return null;
    case "workspace_terminal_close": {
      const input = payload as { sessionId?: string };
      if (input.sessionId) sessions.delete(input.sessionId);
      record(command, payload);
      if (input.sessionId) {
        emitLater("workspace-terminal-exit", {
          sessionId: input.sessionId,
          code: 0,
          signal: null,
        });
      }
      return null;
    }
    case "workspace_terminal_close_all": {
      record(command, payload);
      for (const sessionId of sessions.keys()) {
        emitLater("workspace-terminal-exit", {
          sessionId,
          code: 0,
          signal: null,
        });
      }
      sessions.clear();
      return null;
    }
    default:
      return undefined;
  }
}

/** Install terminal mock commands outside the legacy bridge module.
 *
 * Community reset invokes `workspace_terminal_close_all` even when no terminal
 * tab was opened, so every E2E bridge needs this adapter rather than only the
 * terminal-specific specs.
 */
export function installTerminalE2eBridge(): void {
  if (installed) return;
  const base = getNativeBridge();
  const bridge = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "invoke") {
        return <T>(command: string, payload?: Record<string, unknown>) => {
          if (command.startsWith("workspace_terminal_")) {
            return invokeTerminal(command, payload ?? {}) as Promise<T>;
          }
          return target.invoke<T>(command, payload);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as NativeBridge;
  setNativeBridge(bridge);
  reset();
  window.__BUZZ_E2E_TERMINAL_COMMANDS__ = () =>
    commands.map((entry) => structuredClone(entry));
  window.__BUZZ_E2E_RESET_TERMINAL_MOCK__ = reset;
  installed = true;
}
