/**
 * The Tauri lane, unchanged: the Rust `TerminalManager` owns the PTY and
 * pushes output as `app.emit` string payloads. Sessions die with the renderer,
 * so `list`/`attach` have nothing to offer and `ack` has no backpressure to
 * release.
 */
import { invoke, listen, type NativeUnlisten } from "@/shared/api/nativeBridge";
import type {
  TerminalBackend,
  TerminalSessionSummary,
  TerminalStartRequest,
  TerminalStartResult,
  TerminalSubscriber,
} from "./terminalBackend";

type TerminalOutputEvent = {
  sessionId: string;
  data: string;
};

type TerminalExitEvent = {
  sessionId: string;
  code?: number | null;
  signal?: string | null;
};

export const rustTerminalBackend: TerminalBackend = {
  start(request: TerminalStartRequest): Promise<TerminalStartResult> {
    return invoke<TerminalStartResult>("workspace_terminal_start", { request });
  },
  write(sessionId: string, data: string): Promise<void> {
    return invoke("workspace_terminal_write", { sessionId, data });
  },
  resize(
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth = 0,
    pixelHeight = 0,
  ): Promise<void> {
    return invoke("workspace_terminal_resize", {
      sessionId,
      cols,
      rows,
      pixelWidth,
      pixelHeight,
    });
  },
  async ack(): Promise<void> {
    // The Rust lane pushes output unconditionally; there is nothing to resume.
  },
  close(sessionId: string): Promise<void> {
    return invoke("workspace_terminal_close", { sessionId });
  },
  closeAll(): Promise<void> {
    return invoke("workspace_terminal_close_all");
  },
  async list(): Promise<TerminalSessionSummary[]> {
    return [];
  },
  async attach(): Promise<{ replay: Uint8Array }> {
    return { replay: new Uint8Array() };
  },
  async subscribe(subscriber: TerminalSubscriber): Promise<NativeUnlisten> {
    const unlisten = await Promise.all([
      listen<TerminalOutputEvent>("workspace-terminal-output", (event) => {
        subscriber.onData(event.payload.sessionId, event.payload.data);
      }),
      listen<TerminalExitEvent>("workspace-terminal-exit", (event) => {
        subscriber.onExit(event.payload.sessionId, {
          code: event.payload.code ?? null,
          signal: event.payload.signal ?? null,
        });
      }),
    ]);
    return () => {
      for (const remove of unlisten) remove();
    };
  },
};
