import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

import {
  disposeWebSession,
  ensureWebSession,
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
  await disposeWebSession("tab-late");
  resolveStart({
    sessionId: "late-session",
    targetId: "target-1",
    url: "about:blank",
    ownsBrowserProcess: true,
  });
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
