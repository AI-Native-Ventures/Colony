import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

const PREFIX = "@colony-native:";
const MAX_FRAME = 16 * 1024 * 1024;

/** Updates may transfer a full application; ordinary native calls stay bounded. */
export function nativeRequestTimeout(type, command, fallback) {
  if (type !== "invoke") return fallback;
  if (command === "plugin:updater|download")
    return Math.max(fallback, 16 * 60_000);
  if (command === "plugin:updater|install")
    return Math.max(fallback, 5 * 60_000);
  if (command === "electron_check_for_update")
    return Math.max(fallback, 130_000);
  return fallback;
}

/** Private stdio client. Native payloads are never echoed to logs. */
export class NativeHost extends EventEmitter {
  pending = new Map();
  sequence = 0;
  buffer = Buffer.alloc(0);
  ended = false;

  constructor(
    executable,
    {
      env = process.env,
      spawnProcess = spawn,
      timeout = 60000,
      shutdownGrace = 5000,
    } = {},
  ) {
    super();
    this.timeout = timeout;
    this.shutdownGrace = shutdownGrace;
    this.child = spawnProcess(executable, [], {
      env: { ...env, COLONY_ELECTRON_HOST: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Consumers await ready, but process failure may arrive before they attach.
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(
      () => this.fail("Native host startup timed out"),
      timeout,
    );
    this.child.stdout.on("data", (data) => this.receive(data));
    // Do not forward native logs: existing commands may include local paths/data.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail("Native host could not start"));
    this.exited = new Promise((resolve) =>
      this.child.once("exit", (code, signal) => {
        this.childExited = true;
        clearTimeout(this.killTimer);
        this.fail(
          `Native host exited (code ${code ?? "none"}, signal ${signal ?? "none"})`,
        );
        resolve();
      }),
    );
    this.child.stdin.on("error", () => this.fail("Native host pipe closed"));
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const end = this.buffer.indexOf(10);
      if ((end === -1 ? this.buffer.length : end) > MAX_FRAME + PREFIX.length) {
        this.fail("Native response exceeds frame limit");
        return;
      }
      if (end === -1) return;
      const line = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      // Legacy stdout diagnostics are not RPC and are deliberately not logged.
      if (!line.startsWith(PREFIX)) continue;
      let message;
      try {
        message = JSON.parse(line.slice(PREFIX.length));
        if (!message || typeof message !== "object") throw new Error();
      } catch {
        this.fail("Malformed native response");
        return;
      }
      if (message.type === "ready") {
        if (message.version !== 1) {
          this.fail("Unsupported native protocol");
          return;
        }
        clearTimeout(this.readyTimer);
        this.resolveReady();
      } else if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (Object.hasOwn(message, "error")) pending.reject(message.error);
        else pending.resolve(message.result);
      } else if (["event", "channel"].includes(message.type))
        this.emit(message.type, message);
      else {
        this.fail("Unknown native frame");
        return;
      }
    }
  }

  fail(message) {
    if (this.ended) return;
    this.ended = true;
    this.disconnectReason = message;
    clearTimeout(this.readyTimer);
    const error = new Error(message);
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", message);
    this.child.stdin.destroy();
    if (!this.childExited) {
      this.child.kill("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (!this.childExited) this.child.kill("SIGKILL");
      }, this.shutdownGrace);
      this.killTimer.unref();
    }
  }

  /** Reserve ids before subscribing so early pushes cannot be lost. */
  nextId() {
    return ++this.sequence;
  }

  async request(type, params = {}, id = this.nextId()) {
    await this.ready;
    if (this.ended)
      throw new Error(`Native host is disconnected: ${this.disconnectReason}`);
    if (this.pending.size >= 128) throw new Error("Native host is busy");
    const frame = `${JSON.stringify({ ...params, type, id })}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME)
      throw new Error("Native request exceeds frame limit");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error("Native command timed out; its result is unknown"));
        },
        nativeRequestTimeout(type, params.command, this.timeout),
      );
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame, (error) => {
        if (error) this.fail("Native request pipe closed");
      });
    });
  }

  /** Ask Rust to drain its managed processes before terminating the helper. */
  async close() {
    if (this.childExited) return;
    if (!this.ended) this.child.stdin.end('{"type":"shutdown"}\n');
    const force = setTimeout(() => {
      if (!this.childExited) this.child.kill("SIGKILL");
    }, this.shutdownGrace);
    let deadline;
    try {
      await Promise.race([
        this.exited,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error("Native host termination could not be confirmed"),
              ),
            this.shutdownGrace + 1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(force);
      clearTimeout(deadline);
    }
  }
}
