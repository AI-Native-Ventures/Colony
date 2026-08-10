import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

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

test("dispose fences a deferred native start and closes its late PTY", async () => {
  const startGate = deferred();
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_terminal_start") return startGate.promise;
      return null;
    }),
  );

  const sessions = await import("./terminalSessions.ts");
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
    cwd: "/Users/test/checkout",
    pid: 9123,
  });
  await Promise.all([start, dispose]);

  assert.deepEqual(
    calls
      .filter(({ command }) => command.startsWith("workspace_terminal_"))
      .map(({ command, args }) => [command, args]),
    [
      ["workspace_terminal_start", { request }],
      ["workspace_terminal_close", { sessionId: "late-session" }],
    ],
  );
  assert.equal(sessions.getTerminalSession("tab-race").sessionId, null);
});

test("reset waits for every deferred start before it resolves", async () => {
  const startGate = deferred();
  const commands = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      commands.push({ command, args });
      if (command === "workspace_terminal_start") return startGate.promise;
      return null;
    }),
  );

  const sessions = await import("./terminalSessions.ts");
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
    cwd: "/Users/test/checkout",
    pid: 9125,
  });
  await Promise.all([start, reset]);
  assert.deepEqual(
    commands.map(({ command, args }) => [command, args]),
    [
      ["workspace_terminal_start", { request }],
      ["workspace_terminal_close_all", null],
      ["workspace_terminal_close", { sessionId: "reset-late-session" }],
    ],
  );
});

test("a concurrent ensure waiter cannot resurrect a disposed start", async () => {
  const startGate = deferred();
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_terminal_start") return startGate.promise;
      return null;
    }),
  );

  const sessions = await import("./terminalSessions.ts");
  const first = sessions.ensureTerminalSession("tab-waiter-dispose", request);
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = sessions.ensureTerminalSession("tab-waiter-dispose", request);
  const dispose = sessions.disposeTerminalSession("tab-waiter-dispose");
  startGate.resolve({
    sessionId: "waiter-dispose-late-session",
    cwd: "/Users/test/checkout",
    pid: 9130,
  });

  await Promise.all([first, waiting, dispose]);
  assert.deepEqual(
    calls
      .filter(({ command }) => command.startsWith("workspace_terminal_"))
      .map(({ command, args }) => [command, args]),
    [
      ["workspace_terminal_start", { request }],
      [
        "workspace_terminal_close",
        { sessionId: "waiter-dispose-late-session" },
      ],
    ],
  );
  assert.equal(
    sessions.getTerminalSession("tab-waiter-dispose").sessionId,
    null,
  );
});

test("an ensure waiting through reset cannot resurrect an old-community start", async () => {
  const startGate = deferred();
  const closeAllGate = deferred();
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_terminal_start") return startGate.promise;
      if (command === "workspace_terminal_close_all")
        return closeAllGate.promise;
      return null;
    }),
  );

  const sessions = await import("./terminalSessions.ts");
  const first = sessions.ensureTerminalSession("tab-waiter-reset", request);
  await new Promise((resolve) => setImmediate(resolve));
  const reset = sessions.resetTerminalSessions();
  const waiting = sessions.ensureTerminalSession("tab-waiter-reset", request);
  await new Promise((resolve) => setImmediate(resolve));

  closeAllGate.resolve(null);
  startGate.resolve({
    sessionId: "waiter-reset-late-session",
    cwd: "/Users/test/checkout",
    pid: 9131,
  });

  await Promise.all([first, waiting, reset]);
  assert.deepEqual(
    calls
      .filter(({ command }) => command.startsWith("workspace_terminal_"))
      .map(({ command, args }) => [command, args]),
    [
      ["workspace_terminal_start", { request }],
      ["workspace_terminal_close_all", null],
      ["workspace_terminal_close", { sessionId: "waiter-reset-late-session" }],
    ],
  );
  assert.equal(sessions.getTerminalSession("tab-waiter-reset").sessionId, null);
});
