import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

import {
  applyWebSessionEventForTest,
  disposeWebSession,
  ensureWebSession,
  getWebSession,
  goBackWeb,
  navigateWeb,
  reloadWeb,
  resetWebSessions,
  resizeWeb,
  sendWebText,
  sendWebWheel,
  normalizeWebNavigationUrl,
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
  await resizeWeb("tab-1", 1280, 720);
  await goBackWeb("tab-1");
  await reloadWeb("tab-1");

  assert.deepEqual(
    calls.filter(({ command }) =>
      [
        "workspace_web_mouse",
        "workspace_web_wheel",
        "workspace_web_text",
        "workspace_web_resize",
        "workspace_web_back",
        "workspace_web_reload",
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
      {
        command: "workspace_web_resize",
        args: { sessionId: "session-1", width: 1280, height: 720 },
      },
      {
        command: "workspace_web_back",
        args: { sessionId: "session-1" },
      },
      {
        command: "workspace_web_reload",
        args: { sessionId: "session-1" },
      },
    ],
  );

  await disposeWebSession("tab-1");
  await resetWebSessions();
});

test("coalesces wheel bursts and keeps one native call in flight", async () => {
  const calls = [];
  let resolveFirstWheel;
  const firstWheel = new Promise((resolve) => {
    resolveFirstWheel = resolve;
  });
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      if (command === "workspace_web_start") {
        return {
          sessionId: "session-wheel-burst",
          targetId: "target-1",
          url: "about:blank",
          ownsBrowserProcess: false,
          browserPid: null,
        };
      }
      if (command === "workspace_web_wheel") {
        calls.push(args);
        if (calls.length === 1) await firstWheel;
      }
      return null;
    }),
  );

  try {
    await ensureWebSession("tab-wheel-burst", {
      endpoint: "127.0.0.1:9222",
      targetId: "target-1",
      url: "about:blank",
    });
    const firstBatch = Array.from({ length: 12 }, (_, index) =>
      sendWebWheel("tab-wheel-burst", {
        x: index,
        y: index * 2,
        deltaX: 3,
        deltaY: 24,
      }),
    );
    assert.equal(calls.length, 0);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, {
      x: 11,
      y: 22,
      deltaX: 36,
      deltaY: 288,
    });

    const secondBatch = Array.from({ length: 4 }, (_, index) =>
      sendWebWheel("tab-wheel-burst", {
        x: 20 + index,
        y: 40 + index,
        deltaX: 1,
        deltaY: 10,
      }),
    );
    assert.equal(calls.length, 1);
    resolveFirstWheel();
    await Promise.all(firstBatch);
    await Promise.resolve();
    await Promise.all(secondBatch);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].input, {
      x: 23,
      y: 43,
      deltaX: 4,
      deltaY: 40,
    });
  } finally {
    await disposeWebSession("tab-wheel-burst");
    await resetWebSessions();
  }
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

test("rejects hostile restored URLs before native start", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      return null;
    }),
  );

  for (const [index, url] of [
    "file:///Users/person/private.txt",
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "https://user:secret@example.com/private",
    "http://user@example.com/private",
    "https://example.com/\nheader: value",
  ].entries()) {
    const tabId = `tab-hostile-url-${index}`;
    await ensureWebSession(tabId, { endpoint: null, targetId: null, url });
    assert.equal(getWebSession(tabId).status, "error");
    assert.equal(
      getWebSession(tabId).error,
      "This address cannot be opened. Use http://, https://, or about:blank.",
    );
  }

  assert.equal(
    calls.filter(({ command }) => command === "workspace_web_start").length,
    0,
  );
  await resetWebSessions();
});

test("normalizes only about blank and credential-free HTTP URLs", () => {
  assert.equal(normalizeWebNavigationUrl(" about:blank "), "about:blank");
  assert.equal(
    normalizeWebNavigationUrl(" https://example.com/path?q=1#result "),
    "https://example.com/path?q=1#result",
  );
  assert.equal(normalizeWebNavigationUrl("file:///tmp/private"), null);
  assert.equal(normalizeWebNavigationUrl("https://user@example.com"), null);
  assert.equal(
    normalizeWebNavigationUrl("https://example.com/\nheader: value"),
    null,
  );
});

test("rejects hostile navigation before the native command", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") {
        return {
          sessionId: "session-safe-navigation",
          targetId: "target-1",
          url: "about:blank",
          ownsBrowserProcess: false,
          browserPid: null,
        };
      }
      if (command === "workspace_web_navigate") {
        throw new Error("failed at /Users/person/private/socket");
      }
      return null;
    }),
  );

  await ensureWebSession("tab-safe-navigation", {
    endpoint: null,
    targetId: null,
    url: "about:blank",
  });
  await navigateWeb("tab-safe-navigation", "file:///Users/person/private");
  assert.equal(
    calls.filter(({ command }) => command === "workspace_web_navigate").length,
    0,
  );
  assert.equal(
    getWebSession("tab-safe-navigation").error,
    "This address cannot be opened. Use http://, https://, or about:blank.",
  );

  await navigateWeb("tab-safe-navigation", "https://example.com/failure");
  assert.equal(
    getWebSession("tab-safe-navigation").error,
    "This page could not be opened. Check the address and try again.",
  );
  assert.doesNotMatch(
    getWebSession("tab-safe-navigation").error,
    /Users|private|socket/,
  );
  await disposeWebSession("tab-safe-navigation");
  await resetWebSessions();
});

test("retries atomically after runtime failure and ignores late old events", async () => {
  const calls = [];
  let startCount = 0;
  let releaseClose;
  const heldClose = new Promise((resolve) => {
    releaseClose = resolve;
  });
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") {
        startCount += 1;
        return {
          sessionId: startCount === 1 ? "session-old" : "session-replacement",
          targetId: `target-${startCount}`,
          url: "https://example.com/retry",
          ownsBrowserProcess: false,
          browserPid: null,
        };
      }
      if (
        command === "workspace_web_close" &&
        args.sessionId === "session-old"
      ) {
        await heldClose;
      }
      return null;
    }),
  );

  const request = {
    endpoint: null,
    targetId: null,
    url: "https://example.com/retry",
  };
  await ensureWebSession("tab-atomic-retry", request);
  applyWebSessionEventForTest({
    type: "error",
    payload: {
      sessionId: "session-old",
      error: "runtime failed at /Users/person/private/socket",
    },
  });
  assert.equal(getWebSession("tab-atomic-retry").status, "error");
  assert.equal(
    getWebSession("tab-atomic-retry").error,
    "The browser session stopped unexpectedly. Try again.",
  );

  const firstRetry = ensureWebSession("tab-atomic-retry", request);
  const repeatedRetry = ensureWebSession("tab-atomic-retry", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls
      .filter(({ command }) =>
        ["workspace_web_start", "workspace_web_close"].includes(command),
      )
      .map(({ command, args }) => ({ command, sessionId: args?.sessionId })),
    [
      { command: "workspace_web_start", sessionId: undefined },
      { command: "workspace_web_close", sessionId: "session-old" },
    ],
  );

  applyWebSessionEventForTest({
    type: "error",
    payload: { sessionId: "session-old", error: "late private detail" },
  });
  assert.equal(getWebSession("tab-atomic-retry").status, "connecting");
  releaseClose();
  await Promise.all([firstRetry, repeatedRetry]);
  assert.equal(startCount, 2);
  assert.equal(getWebSession("tab-atomic-retry").status, "running");
  assert.equal(
    getWebSession("tab-atomic-retry").sessionId,
    "session-replacement",
  );

  applyWebSessionEventForTest({
    type: "closed",
    payload: { sessionId: "session-old", error: "late raw path /tmp/x" },
  });
  assert.equal(getWebSession("tab-atomic-retry").status, "running");
  assert.equal(
    getWebSession("tab-atomic-retry").sessionId,
    "session-replacement",
  );
  await disposeWebSession("tab-atomic-retry");
  await resetWebSessions();
});

test("closes a previously closed native session before replacement start", async () => {
  const calls = [];
  let startCount = 0;
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_web_start") {
        startCount += 1;
        return {
          sessionId: `closed-retry-${startCount}`,
          targetId: `target-${startCount}`,
          url: "https://example.com/closed",
          ownsBrowserProcess: false,
          browserPid: null,
        };
      }
      return null;
    }),
  );
  const request = {
    endpoint: null,
    targetId: null,
    url: "https://example.com/closed",
  };
  await ensureWebSession("tab-closed-retry", request);
  applyWebSessionEventForTest({
    type: "closed",
    payload: { sessionId: "closed-retry-1", error: null },
  });
  await ensureWebSession("tab-closed-retry", request);

  assert.deepEqual(
    calls
      .filter(({ command }) =>
        ["workspace_web_start", "workspace_web_close"].includes(command),
      )
      .map(({ command, args }) => ({ command, sessionId: args?.sessionId })),
    [
      { command: "workspace_web_start", sessionId: undefined },
      { command: "workspace_web_close", sessionId: "closed-retry-1" },
      { command: "workspace_web_start", sessionId: undefined },
    ],
  );
  await disposeWebSession("tab-closed-retry");
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

test("deduplicates a pending start and allows retry after failure", async () => {
  const calls = [];
  let rejectFirstStart;
  const firstStart = new Promise((_, reject) => {
    rejectFirstStart = reject;
  });
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command !== "workspace_web_start") return null;
      const startNumber = calls.filter(
        (entry) => entry.command === "workspace_web_start",
      ).length;
      if (startNumber === 1) return firstStart;
      return {
        sessionId: "session-retry",
        targetId: "target-retry",
        url: "https://docs.example.com/retry",
        ownsBrowserProcess: false,
        browserPid: null,
      };
    }),
  );

  const request = {
    endpoint: null,
    targetId: null,
    url: "https://docs.example.com/retry",
  };
  const first = ensureWebSession("tab-retry", request);
  const duplicate = ensureWebSession("tab-retry", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    calls.filter(({ command }) => command === "workspace_web_start").length,
    1,
  );

  rejectFirstStart(new Error("Browser start failed"));
  await Promise.all([first, duplicate]);
  assert.equal(getWebSession("tab-retry").status, "error");
  assert.equal(
    getWebSession("tab-retry").error,
    "The browser could not be started. Check the connection and try again.",
  );

  await ensureWebSession("tab-retry", request);
  assert.equal(
    calls.filter(({ command }) => command === "workspace_web_start").length,
    2,
  );
  assert.equal(getWebSession("tab-retry").status, "running");
  assert.equal(getWebSession("tab-retry").error, null);

  await disposeWebSession("tab-retry");
  await resetWebSessions();
});
