import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

import {
  disposeWebSession,
  ensureWebSession,
  getWebSession,
  resetWebSessions,
  sendWebText,
  sendWebWheel,
} from "./webSessions.ts";

test("forwards wheel and text input through the native web session", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") {
        return {
          sessionId: "session-1",
          targetId: "target-1",
          url: "about:blank",
          ownsBrowserProcess: false,
          browserPid: null,
        };
      }
      return null;
    }),
  );

  await ensureWebSession("tab-1", {
    endpoint: "127.0.0.1:9222",
    targetId: "target-1",
    url: "about:blank",
  });
  assert.equal(getWebSession("tab-1").browserPid, null);
  await sendWebWheel("tab-1", {
    x: 32,
    y: 48,
    deltaX: 0,
    deltaY: 120,
  });
  await sendWebText("tab-1", "hello");

  assert.deepEqual(
    calls.filter(({ command }) =>
      [
        "workspace_web_mouse",
        "workspace_web_wheel",
        "workspace_web_text",
      ].includes(command),
    ),
    [
      {
        command: "workspace_web_wheel",
        args: {
          sessionId: "session-1",
          input: { x: 32, y: 48, deltaX: 0, deltaY: 120 },
        },
      },
      {
        command: "workspace_web_text",
        args: { sessionId: "session-1", text: "hello" },
      },
    ],
  );

  await disposeWebSession("tab-1");
  await resetWebSessions();
});

test("does not forward hostile launch controls from a restored tab payload", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") {
        return {
          sessionId: "session-trusted-launch",
          targetId: "target-1",
          url: "about:blank",
          ownsBrowserProcess: true,
          browserPid: 4242,
        };
      }
      return null;
    }),
  );

  await ensureWebSession("tab-hostile", {
    endpoint: null,
    targetId: null,
    url: "about:blank",
    binary: "/tmp/attacker-controlled-browser",
    headless: false,
  });
  assert.equal(getWebSession("tab-hostile").browserPid, 4242);
  assert.equal(getWebSession("tab-hostile").ownsBrowserProcess, true);

  assert.deepEqual(
    calls.find(({ command }) => command === "workspace_web_start"),
    {
      command: "workspace_web_start",
      args: {
        request: {
          endpoint: null,
          targetId: null,
          url: "about:blank",
        },
      },
    },
  );
  await disposeWebSession("tab-hostile");
  await resetWebSessions();
});

test("a start that resolves after tab disposal closes its late native session", async () => {
  const calls = [];
  let resolveStart;
  const startResult = new Promise((resolve) => {
    resolveStart = resolve;
  });
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") return startResult;
      return null;
    }),
  );

  const pendingStart = ensureWebSession("tab-late", {
    endpoint: "127.0.0.1:9222",
    targetId: "target-1",
    url: "about:blank",
  });
  let disposed = false;
  const pendingDispose = disposeWebSession("tab-late").then(() => {
    disposed = true;
  });
  await Promise.resolve();
  assert.equal(disposed, false);
  resolveStart({
    sessionId: "late-session",
    targetId: "target-1",
    url: "about:blank",
    ownsBrowserProcess: true,
  });
  await pendingDispose;
  await pendingStart;

  assert.deepEqual(
    calls.filter(({ command }) => command.startsWith("workspace_web_")),
    [
      {
        command: "workspace_web_start",
        args: {
          request: {
            endpoint: "127.0.0.1:9222",
            targetId: "target-1",
            url: "about:blank",
          },
        },
      },
      {
        command: "workspace_web_close",
        args: { sessionId: "late-session" },
      },
    ],
  );
  await resetWebSessions();
});
