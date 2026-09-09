import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const RING_LIMIT = 1024 * 1024;
const PAUSE_BYTES = 512 * 1024;
const RESUME_BYTES = 128 * 1024;
// Matches the Rust lane's ladder (src-tauri/src/terminal.rs): hang up, then
// escalate on the process group so a shell that ignores SIGHUP still dies.
const GROUP_TERM_DELAY = 2000;
const GROUP_KILL_DELAY = 5000;
const REAP_GRACE = 1000;

const require = createRequire(import.meta.url);

/**
 * node-pty 1.1.0 publishes `spawn-helper` with mode 0644, so `posix_spawnp`
 * fails for every consumer until the bit is restored. node-pty resolves the
 * helper relative to its own `lib/`, remapping asar paths; mirror that.
 */
export function ensureSpawnHelperExecutable(
  entry = require.resolve("node-pty"),
) {
  const lib = dirname(entry);
  const candidates = [
    "build/Release",
    "build/Debug",
    `prebuilds/${process.platform}-${process.arch}`,
  ]
    .flatMap((dir) =>
      ["..", "."].map((base) => resolve(lib, base, dir, "spawn-helper")),
    )
    .map((path) =>
      path
        .replace("app.asar", "app.asar.unpacked")
        .replace("node_modules.asar", "node_modules.asar.unpacked"),
    );
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Not present, or present without the executable bit.
    }
    try {
      statSync(path);
      chmodSync(path, 0o755);
      return path;
    } catch {
      // Absent, or on a read-only mount where packaging already set the mode.
    }
  }
  return undefined;
}

/** Descendants of `root`, deepest first, from a single `ps` snapshot. */
function processTree(root) {
  let output;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = [];
  const pending = [root];
  while (pending.length) {
    for (const child of children.get(pending.pop()) ?? []) {
      if (found.includes(child)) continue;
      found.push(child);
      pending.push(child);
    }
  }
  return found.reverse();
}

function signal(target, name) {
  try {
    process.kill(target, name);
  } catch (error) {
    // ESRCH simply means the process finished first.
    if (error?.code !== "ESRCH") throw error;
  }
}

/**
 * Job control gives a backgrounded child its own process group, so signalling
 * the leader's group alone would orphan it. Signal the tree, then the group.
 */
function reapTree(pid, force) {
  const name = force ? "SIGKILL" : "SIGTERM";
  for (const descendant of processTree(pid)) signal(descendant, name);
  signal(-pid, name);
}

/** Bounded tail of a session's output. Bytes are never logged. */
class RingBuffer {
  chunks = [];
  size = 0;

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > RING_LIMIT) {
      const excess = this.size - RING_LIMIT;
      const head = this.chunks[0];
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  read() {
    const joined = Buffer.concat(this.chunks, this.size);
    this.chunks = joined.length ? [joined] : [];
    return joined;
  }
}

/**
 * PTY sessions owned by the Electron main process. Sessions outlive a renderer
 * reload; the renderer reattaches with `list` + `attach` and replays the tail.
 */
export class TerminalService {
  sessions = new Map();

  constructor({ onData = () => {}, onExit = () => {}, spawn } = {}) {
    this.onData = onData;
    this.onExit = onExit;
    this.spawn = spawn;
  }

  spawnPty(file, args, options) {
    if (this.spawn) return this.spawn(file, args, options);
    ensureSpawnHelperExecutable();
    return require("node-pty").spawn(file, args, options);
  }

  start({ cwd, cols = 80, rows = 24, env = {} } = {}) {
    if (typeof cwd !== "string" || !cwd)
      throw new Error("A terminal needs a working directory");
    let stats;
    try {
      stats = statSync(cwd);
    } catch {
      throw new Error("Terminal working directory does not exist");
    }
    if (!stats.isDirectory())
      throw new Error("Terminal working directory is not a directory");

    const shell = process.env.SHELL?.trim() || "/bin/sh";
    // A GUI-launched app inherits a minimal PATH; a login shell sources the
    // user's profile, matching what VS Code does on macOS.
    const pty = this.spawnPty(shell, ["-i", "-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // Buffers, not strings: node-pty's utf8 decoding splits multi-byte
      // sequences across chunks, which is what garbles emoji today.
      encoding: null,
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "Colony",
          ...env,
        }).filter(([, value]) => typeof value === "string"),
      ),
    });

    const sessionId = randomUUID();
    const session = {
      sessionId,
      pty,
      pid: pty.pid,
      cwd,
      alive: true,
      paused: false,
      unacked: 0,
      ring: new RingBuffer(),
      closing: null,
    };
    session.exited = new Promise((resolveExit) => {
      session.markExited = resolveExit;
    });
    this.sessions.set(sessionId, session);

    pty.onData((chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      session.ring.push(bytes);
      session.unacked += bytes.length;
      if (!session.paused && session.unacked > PAUSE_BYTES) {
        session.paused = true;
        session.pty.pause();
      }
      this.onData(sessionId, bytes);
    });
    pty.onExit(({ exitCode, signal: exitSignal }) => {
      session.alive = false;
      session.markExited();
      this.onExit(sessionId, {
        code: exitCode ?? null,
        signal: exitSignal ?? null,
      });
    });

    return { sessionId, pid: session.pid, cwd };
  }

  require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown terminal session");
    return session;
  }

  write(sessionId, data) {
    const session = this.require(sessionId);
    if (session.alive) session.pty.write(data);
  }

  resize(sessionId, cols, rows) {
    const session = this.require(sessionId);
    if (session.alive) session.pty.resize(cols, rows);
  }

  /** Renderer reports bytes actually rendered, releasing the PTY's backpressure. */
  ack(sessionId, bytes) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.unacked = Math.max(0, session.unacked - bytes);
    if (session.paused && session.unacked < RESUME_BYTES) {
      session.paused = false;
      if (session.alive) session.pty.resume();
    }
  }

  isPaused(sessionId) {
    return this.sessions.get(sessionId)?.paused ?? false;
  }

  list() {
    return [...this.sessions.values()].map(
      ({ sessionId, pid, cwd, alive }) => ({
        sessionId,
        pid,
        cwd,
        alive,
      }),
    );
  }

  attach(sessionId) {
    return { replay: this.require(sessionId).ring.read() };
  }

  settled(session, timeout) {
    return Promise.race([
      session.exited.then(() => true),
      new Promise((resolveRace) => {
        const timer = setTimeout(() => resolveRace(false), timeout);
        timer.unref?.();
      }),
    ]);
  }

  close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    session.closing ??= (async () => {
      const { pid } = session;
      // Under job control a backgrounded job sits in its own process group, so
      // the leader's hangup never reaches it. Snapshot the tree while the shell
      // is still alive, before its children are reparented away from it.
      const descendants = session.alive ? processTree(pid) : [];
      if (session.alive) {
        try {
          session.pty.kill();
        } catch {
          // The shell may have exited between the check and the signal.
        }
      }
      for (const descendant of descendants) signal(descendant, "SIGTERM");
      if (!(await this.settled(session, GROUP_TERM_DELAY))) {
        reapTree(pid, false);
        if (
          !(await this.settled(session, GROUP_KILL_DELAY - GROUP_TERM_DELAY))
        ) {
          reapTree(pid, true);
          await this.settled(session, REAP_GRACE);
        }
      }
      for (const descendant of descendants) signal(descendant, "SIGKILL");
      this.sessions.delete(sessionId);
    })();
    return session.closing;
  }

  closeAll() {
    return Promise.all(
      [...this.sessions.keys()].map((id) => this.close(id)),
    ).then(() => {});
  }
}
