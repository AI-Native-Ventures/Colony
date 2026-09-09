/**
 * The Electron lane: the PTY lives in the main process and its bytes reach the
 * renderer over IPC, so sessions survive a renderer reload. Only the checkout
 * path still comes from Rust — `workspace_terminal_resolve_cwd` wraps the same
 * repo lookup `workspace_terminal_start` uses, so the two lanes cannot drift.
 */
import {
  invoke,
  nativeTerminal,
  type NativeTerminalApi,
  type NativeUnlisten,
} from "@/shared/api/nativeBridge";
import type {
  TerminalBackend,
  TerminalSessionSummary,
  TerminalStartRequest,
  TerminalStartResult,
  TerminalSubscriber,
} from "./terminalBackend";

function terminal(): NativeTerminalApi {
  const api = nativeTerminal();
  if (!api) throw new Error("The shell does not host terminal sessions");
  return api;
}

export const electronTerminalBackend: TerminalBackend = {
  async start(request: TerminalStartRequest): Promise<TerminalStartResult> {
    const cwd = await invoke<string>("workspace_terminal_resolve_cwd", {
      request: {
        reposDir: request.reposDir,
        projectDtag: request.projectDtag,
        cloneUrl: request.cloneUrl,
      },
    });
    const started = await terminal().start({
      cwd,
      cols: request.cols,
      rows: request.rows,
    });
    return {
      sessionId: started.sessionId,
      cwd: started.cwd ?? cwd,
      pid: started.pid ?? null,
    };
  },
  write(sessionId: string, data: string): Promise<void> {
    return terminal().write({ sessionId, data });
  },
  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return terminal().resize({ sessionId, cols, rows });
  },
  ack(sessionId: string, bytes: number): Promise<void> {
    return terminal().ack({ sessionId, bytes });
  },
  close(sessionId: string): Promise<void> {
    return terminal().close({ sessionId });
  },
  closeAll(): Promise<void> {
    return terminal().closeAll();
  },
  list(): Promise<TerminalSessionSummary[]> {
    return terminal().list();
  },
  attach(sessionId: string): Promise<{ replay: Uint8Array }> {
    return terminal().attach({ sessionId });
  },
  async subscribe(subscriber: TerminalSubscriber): Promise<NativeUnlisten> {
    const api = terminal();
    const removeData = api.onData((sessionId, chunk) => {
      subscriber.onData(sessionId, chunk);
    });
    const removeExit = api.onExit((sessionId, info) => {
      subscriber.onExit(sessionId, {
        code: info?.code ?? null,
        signal: info?.signal ?? null,
      });
    });
    return () => {
      removeData();
      removeExit();
    };
  },
};
