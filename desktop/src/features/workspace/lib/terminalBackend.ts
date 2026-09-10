/**
 * The PTY host behind a workspace terminal tab. Two shells, two owners:
 * Electron keeps the PTY in its main process (`TerminalService`), Tauri keeps
 * it in the Rust `TerminalManager`. `terminalSessions.ts` talks only to this
 * interface, so the switch is a selection rather than a branch per call.
 */
import { nativeTerminal, type NativeUnlisten } from "@/shared/api/nativeBridge";
import { electronTerminalBackend } from "./electronTerminalBackend";
import { rustTerminalBackend } from "./rustTerminalBackend";

export type TerminalStartRequest = {
  channelId: string;
  /**
   * Explicit working directory (an agent's worktree). Used verbatim when the
   * path exists; the project checkout is the fallback.
   */
  cwd: string | null;
  projectDtag: string | null;
  cloneUrl: string | null;
  reposDir: string | null;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
  pid: number | null;
};

export type TerminalSessionSummary = {
  sessionId: string;
  pid: number | null;
  cwd: string;
  alive: boolean;
};

export type TerminalExitInfo = {
  code: number | null;
  signal: string | null;
};

/**
 * Output as the host delivers it: bytes from Electron (structured clone keeps
 * multi-byte sequences intact), strings from the Rust event payload.
 */
export type TerminalChunk = Uint8Array | string;

export type TerminalSubscriber = {
  onData(sessionId: string, chunk: TerminalChunk): void;
  onExit(sessionId: string, info: TerminalExitInfo): void;
};

export interface TerminalBackend {
  start(request: TerminalStartRequest): Promise<TerminalStartResult>;
  write(sessionId: string, data: string): Promise<void>;
  resize(
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth?: number,
    pixelHeight?: number,
  ): Promise<void>;
  /** Release backpressure for bytes the renderer rendered. No-op on Rust. */
  ack(sessionId: string, bytes: number): Promise<void>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
  /** Sessions the host still holds. Empty on Rust: it has no reattach. */
  list(): Promise<TerminalSessionSummary[]>;
  /** Replay buffer for a session picked back up. Empty on Rust. */
  attach(sessionId: string): Promise<{ replay: Uint8Array }>;
  subscribe(subscriber: TerminalSubscriber): Promise<NativeUnlisten>;
}

let injected: TerminalBackend | null = null;

/** Unit tests drive `terminalSessions` against a fake host. */
export function setTerminalBackendForTests(
  backend: TerminalBackend | null,
): void {
  injected = backend;
}

/**
 * Electron whenever the shell exposes its PTY surface, Rust otherwise.
 * Resolved per call: the bridge is installed before the first render, but
 * tests install theirs after this module is imported.
 */
export function selectTerminalBackend(): TerminalBackend {
  if (injected) return injected;
  return nativeTerminal() ? electronTerminalBackend : rustTerminalBackend;
}
