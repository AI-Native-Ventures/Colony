import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";
import {
  selectTerminalBackend,
  setTerminalBackendForTests,
} from "./terminalBackend.ts";
import { electronTerminalBackend } from "./electronTerminalBackend.ts";
import { rustTerminalBackend } from "./rustTerminalBackend.ts";

function installBridge(terminal, invokeHandler = async () => null) {
  const bridge = createMockNativeBridge(invokeHandler);
  setNativeBridge(terminal ? { ...bridge, terminal } : bridge);
}

test("the shell's PTY surface decides which backend drives the terminal", () => {
  setTerminalBackendForTests(null);

  installBridge(undefined);
  assert.equal(selectTerminalBackend(), rustTerminalBackend);

  installBridge({});
  assert.equal(selectTerminalBackend(), electronTerminalBackend);
});

test("an injected backend wins over the selection", () => {
  const fake = { name: "fake" };
  setTerminalBackendForTests(fake);
  installBridge({});
  assert.equal(selectTerminalBackend(), fake);
  setTerminalBackendForTests(null);
});

test("the Electron backend resolves the checkout through Rust, then starts the PTY", async () => {
  setTerminalBackendForTests(null);
  const invocations = [];
  const started = [];
  installBridge(
    {
      start: async (payload) => {
        started.push(payload);
        return { sessionId: "pty-1", pid: 5150, cwd: payload.cwd };
      },
    },
    async (command, args) => {
      invocations.push([command, args]);
      if (command === "workspace_terminal_resolve_cwd")
        return "/workspace/repos/colony";
      return null;
    },
  );

  const result = await selectTerminalBackend().start({
    channelId: "channel-1",
    projectDtag: "colony",
    cloneUrl: "https://example.test/colony.git",
    reposDir: "/workspace/repos",
    cols: 120,
    rows: 40,
    pixelWidth: 0,
    pixelHeight: 0,
  });

  assert.deepEqual(invocations, [
    [
      "workspace_terminal_resolve_cwd",
      {
        request: {
          reposDir: "/workspace/repos",
          projectDtag: "colony",
          cloneUrl: "https://example.test/colony.git",
        },
      },
    ],
  ]);
  assert.deepEqual(started, [
    { cwd: "/workspace/repos/colony", cols: 120, rows: 40 },
  ]);
  assert.deepEqual(result, {
    sessionId: "pty-1",
    cwd: "/workspace/repos/colony",
    pid: 5150,
  });
});

test("the Rust backend keeps the existing command names and has no reattach", async () => {
  setTerminalBackendForTests(null);
  const invocations = [];
  installBridge(undefined, async (command, args) => {
    invocations.push([command, args]);
    return null;
  });

  const backend = selectTerminalBackend();
  await backend.write("session-9", "ls\n");
  await backend.resize("session-9", 100, 30);
  await backend.ack("session-9", 1024);
  await backend.close("session-9");
  await backend.closeAll();

  assert.deepEqual(invocations, [
    ["workspace_terminal_write", { sessionId: "session-9", data: "ls\n" }],
    [
      "workspace_terminal_resize",
      {
        sessionId: "session-9",
        cols: 100,
        rows: 30,
        pixelWidth: 0,
        pixelHeight: 0,
      },
    ],
    ["workspace_terminal_close", { sessionId: "session-9" }],
    ["workspace_terminal_close_all", null],
  ]);
  assert.deepEqual(await backend.list(), []);
  assert.deepEqual(await backend.attach("session-9"), {
    replay: new Uint8Array(),
  });
});
