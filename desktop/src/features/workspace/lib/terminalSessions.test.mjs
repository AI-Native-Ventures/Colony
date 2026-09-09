import assert from "node:assert/strict";
import test from "node:test";

import { setTerminalBackendForTests } from "./terminalBackend.ts";

const request = {
  channelId: "channel-race",
  projectDtag: null,
  cloneUrl: null,
  reposDir: null,
  cols: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
};

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installSessionStorage() {
  const entries = new Map();
  globalThis.sessionStorage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),
  };
  return entries;
}

function createFakeBackend(overrides = {}) {
  const calls = [];
  let subscriber = null;
  return {
    calls,
    emitData(sessionId, chunk) {
      subscriber?.onData(sessionId, chunk);
    },
    emitExit(sessionId, info) {
      subscriber?.onExit(sessionId, info);
    },
    async start(startRequest) {
      calls.push(["start", startRequest]);
      if (overrides.start) return overrides.start(startRequest);
      return { sessionId: "session-1", cwd: "/checkout", pid: 4321 };
    },
    async write(sessionId, data) {
      calls.push(["write", sessionId, data]);
    },
    async resize(sessionId, cols, rows) {
      calls.push(["resize", sessionId, cols, rows]);
    },
    async ack(sessionId, bytes) {
      calls.push(["ack", sessionId, bytes]);
    },
    async close(sessionId) {
      calls.push(["close", sessionId]);
    },
    async closeAll() {
      calls.push(["closeAll"]);
    },
    async list() {
      calls.push(["list"]);
      return overrides.list ? overrides.list() : [];
    },
    async attach(sessionId) {
      calls.push(["attach", sessionId]);
      if (overrides.attach) return overrides.attach(sessionId);
      return { replay: new Uint8Array() };
    },
    async subscribe(next) {
      subscriber = next;
      return () => {
        subscriber = null;
      };
    },
  };
}

const sessions = await import("./terminalSessions.ts");

async function withBackend(backend, storage) {
  storage.clear();
  setTerminalBackendForTests(backend);
  await sessions.resetTerminalSessions();
  storage.clear();
  backend.calls.length = 0;
}

const storage = installSessionStorage();
const KEY = (tabId) => `colony.terminal.session.${tabId}`;

test("a started session runs and is remembered for reattach", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-start", request);

  assert.deepEqual(sessions.getTerminalSession("tab-start"), {
    status: "running",
    sessionId: "session-1",
    cwd: "/checkout",
    pid: 4321,
    error: null,
  });
  assert.deepEqual(backend.calls, [["start", request]]);
  assert.equal(storage.get(KEY("tab-start")), "session-1");
});

test("output that arrives before a listener is flushed to it in order", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-output", request);
  backend.emitData("session-1", "first ");
  backend.emitData("session-1", "second");

  const seen = [];
  const unsubscribe = sessions.subscribeTerminalOutput("tab-output", (chunk) =>
    seen.push(chunk),
  );
  assert.deepEqual(seen, ["first ", "second"]);

  backend.emitData("session-1", " third");
  assert.deepEqual(seen, ["first ", "second", " third"]);
  unsubscribe();
  backend.emitData("session-1", " ignored");
  assert.deepEqual(seen, ["first ", "second", " third"]);
});

test("output emitted before the start resolves is not lost", async () => {
  const gate = deferred();
  const backend = createFakeBackend({ start: () => gate.promise });
  await withBackend(backend, storage);

  const start = sessions.ensureTerminalSession("tab-early", request);
  await new Promise((resolve) => setImmediate(resolve));
  backend.emitData("early-session", "before-adopt");
  gate.resolve({ sessionId: "early-session", cwd: "/checkout", pid: 7 });
  await start;

  const seen = [];
  sessions.subscribeTerminalOutput("tab-early", (chunk) => seen.push(chunk));
  assert.deepEqual(seen, ["before-adopt"]);
});

test("acked bytes reach the backend for the tab's session", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-ack", request);
  await sessions.ackTerminalOutput("tab-ack", 12);
  await sessions.ackTerminalOutput("tab-ack", 0);

  assert.deepEqual(
    backend.calls.filter(([name]) => name === "ack"),
    [["ack", "session-1", 12]],
  );
});

test("a remembered live session is reattached and its replay delivered", async () => {
  const replay = new TextEncoder().encode("replayed");
  const backend = createFakeBackend({
    list: () => [{ sessionId: "kept", pid: 99, cwd: "/checkout", alive: true }],
    attach: () => ({ replay }),
  });
  await withBackend(backend, storage);
  storage.set(KEY("tab-reattach"), "kept");

  await sessions.ensureTerminalSession("tab-reattach", request);

  assert.deepEqual(sessions.getTerminalSession("tab-reattach"), {
    status: "running",
    sessionId: "kept",
    cwd: "/checkout",
    pid: 99,
    error: null,
  });
  assert.deepEqual(backend.calls, [["list"], ["attach", "kept"]]);
  const seen = [];
  sessions.subscribeTerminalOutput("tab-reattach", (chunk) => seen.push(chunk));
  assert.deepEqual(seen, [replay]);
});

test("a stale remembered session falls back to a fresh start", async () => {
  const backend = createFakeBackend({
    list: () => [{ sessionId: "other", pid: 1, cwd: "/x", alive: true }],
  });
  await withBackend(backend, storage);
  storage.set(KEY("tab-stale"), "gone");

  await sessions.ensureTerminalSession("tab-stale", request);

  assert.deepEqual(backend.calls, [["list"], ["start", request]]);
  assert.equal(storage.get(KEY("tab-stale")), "session-1");
});

test("closing a tab closes the PTY and forgets its session", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-close", request);
  await sessions.disposeTerminalSession("tab-close");

  assert.deepEqual(
    backend.calls.filter(([name]) => name === "close"),
    [["close", "session-1"]],
  );
  assert.equal(storage.has(KEY("tab-close")), false);
  assert.equal(sessions.getTerminalSession("tab-close").sessionId, null);
});

test("reset closes every session and clears state, buffers and keys", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-reset", request);
  backend.emitData("session-1", "buffered");
  await sessions.resetTerminalSessions();

  assert.deepEqual(
    backend.calls.filter(([name]) => name === "closeAll"),
    [["closeAll"]],
  );
  assert.equal(storage.size, 0);
  assert.equal(sessions.getTerminalSession("tab-reset").sessionId, null);
  const seen = [];
  sessions.subscribeTerminalOutput("tab-reset", (chunk) => seen.push(chunk));
  assert.deepEqual(seen, []);
});

test("a failed start surfaces as an error state with its message", async () => {
  const backend = createFakeBackend({
    start: () => Promise.reject(new Error("no such directory")),
  });
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-error", request);

  const state = sessions.getTerminalSession("tab-error");
  assert.equal(state.status, "error");
  assert.equal(state.error, "no such directory");
});

test("a PTY exit marks the tab exited", async () => {
  const backend = createFakeBackend();
  await withBackend(backend, storage);

  await sessions.ensureTerminalSession("tab-exit", request);
  backend.emitExit("session-1", { code: null, signal: "SIGKILL" });

  const state = sessions.getTerminalSession("tab-exit");
  assert.equal(state.status, "exited");
  assert.equal(state.error, "Terminal exited with SIGKILL");
});

test("dispose fences a deferred start and closes its late PTY", async () => {
  const startGate = deferred();
  const backend = createFakeBackend({ start: () => startGate.promise });
  await withBackend(backend, storage);

  const start = sessions.ensureTerminalSession("tab-race", request);
  await new Promise((resolve) => setImmediate(resolve));

  let disposed = false;
  const dispose = sessions.disposeTerminalSession("tab-race").then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false, "dispose must await the in-flight start");

  startGate.resolve({
    sessionId: "late-session",
    cwd: "/checkout",
    pid: 9123,
  });
  await Promise.all([start, dispose]);

  assert.deepEqual(backend.calls, [
    ["start", request],
    ["close", "late-session"],
  ]);
  assert.equal(sessions.getTerminalSession("tab-race").sessionId, null);
});

test("reset waits for every deferred start before it resolves", async () => {
  const startGate = deferred();
  const backend = createFakeBackend({ start: () => startGate.promise });
  await withBackend(backend, storage);

  const start = sessions.ensureTerminalSession("tab-reset-race", request);
  await new Promise((resolve) => setImmediate(resolve));
  let resetDone = false;
  const reset = sessions.resetTerminalSessions().then(() => {
    resetDone = true;
  });
  await Promise.resolve();
  assert.equal(resetDone, false, "reset must await the in-flight start");

  startGate.resolve({
    sessionId: "reset-late-session",
    cwd: "/checkout",
    pid: 9125,
  });
  await Promise.all([start, reset]);
  assert.deepEqual(backend.calls, [
    ["start", request],
    ["closeAll"],
    ["close", "reset-late-session"],
  ]);
});

test("a concurrent ensure waiter cannot resurrect a disposed start", async () => {
  const startGate = deferred();
  const backend = createFakeBackend({ start: () => startGate.promise });
  await withBackend(backend, storage);

  const first = sessions.ensureTerminalSession("tab-waiter-dispose", request);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = sessions.ensureTerminalSession("tab-waiter-dispose", request);
  const dispose = sessions.disposeTerminalSession("tab-waiter-dispose");
  startGate.resolve({
    sessionId: "waiter-dispose-late-session",
    cwd: "/checkout",
    pid: 9130,
  });

  await Promise.all([first, waiting, dispose]);
  assert.deepEqual(backend.calls, [
    ["start", request],
    ["close", "waiter-dispose-late-session"],
  ]);
  assert.equal(
    sessions.getTerminalSession("tab-waiter-dispose").sessionId,
    null,
  );
});

test("an ensure waiting through reset cannot resurrect an old-community start", async () => {
  const startGate = deferred();
  const closeAllGate = deferred();
  const backend = createFakeBackend({ start: () => startGate.promise });
  await withBackend(backend, storage);
  const originalCloseAll = backend.closeAll.bind(backend);
  backend.closeAll = () => {
    void originalCloseAll();
    return closeAllGate.promise;
  };

  const first = sessions.ensureTerminalSession("tab-waiter-reset", request);
  await new Promise((resolve) => setImmediate(resolve));
  const reset = sessions.resetTerminalSessions();
  const waiting = sessions.ensureTerminalSession("tab-waiter-reset", request);
  await new Promise((resolve) => setImmediate(resolve));

  closeAllGate.resolve(null);
  startGate.resolve({
    sessionId: "waiter-reset-late-session",
    cwd: "/checkout",
    pid: 9131,
  });

  await Promise.all([first, waiting, reset]);
  assert.deepEqual(backend.calls, [
    ["start", request],
    ["closeAll"],
    ["close", "waiter-reset-late-session"],
  ]);
  assert.equal(sessions.getTerminalSession("tab-waiter-reset").sessionId, null);
});
