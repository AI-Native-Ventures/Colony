import assert from "node:assert/strict";
import test from "node:test";
import { TerminalService } from "./terminal.mjs";
import { registerTerminalIpc } from "./terminal-ipc.mjs";

function makeFakeWebContents() {
  const sends = [];
  return {
    id: 12345,
    sends,
    isDestroyed: () => false,
    send: (channel, ...args) => sends.push({ channel, args }),
  };
}

function makeFakeIpcMain() {
  const handlers = new Map();
  const api = {
    handle(name, handler) {
      handlers.set(name, handler);
    },
    removeHandler(name) {
      handlers.delete(name);
    },
    invoke(name, event, op, payload) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler for ${name}`);
      return handler(event, op, payload);
    },
    handlers,
  };
  return api;
}

function makeEvent(webContents, senderId = 12345) {
  return {
    sender: { id: senderId, ...webContents },
    senderFrame: { url: "colony://app/" },
  };
}

function harness() {
  const chunks = new Map();
  const exits = new Map();
  const service = new TerminalService({
    onData: (sessionId, chunk) => {
      chunks.set(sessionId, [...(chunks.get(sessionId) ?? []), chunk]);
    },
    onExit: (sessionId, status) => exits.set(sessionId, status),
    spawn: () => {
      // Fake spawn so no real PTY is opened
      const events = { onData: () => {}, onExit: () => {} };
      const pty = {
        pid: 99999,
        kill: () => {},
        write: (data) => {
          if (events.onData)
            events.onData(Buffer.isBuffer(data) ? data : Buffer.from(data));
        },
        resize: () => {},
        pause: () => {},
        resume: () => {},
        onData: (cb) => {
          events.onData = cb;
        },
        onExit: (cb) => {
          events.onExit = cb;
        },
        _emitData(chunk) {
          events.onData(chunk);
        },
        _emitExit({ exitCode, signal }) {
          events.onExit({ exitCode, signal });
        },
      };
      return pty;
    },
  });
  return { service, chunks, exits };
}

test("registerTerminalIpc registers handler and dispose removes it", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  const reg = registerTerminalIpc({ ipcMain, webContents, service });
  assert.ok(ipcMain.handlers.get("colony:terminal"));
  reg.dispose();
  assert.equal(ipcMain.handlers.get("colony:terminal"), undefined);
});

test("start returns ok result", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const result = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: "/tmp",
  });
  assert.equal(result.ok, true);
  assert.ok(result.result.sessionId);
  assert.ok(typeof result.result.pid === "number");
});

test("start with bad cwd returns ok false", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const result = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: "/definitely/not/here/ever",
  });
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string");
});

test("list returns sessions", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  const listResult = await ipcMain.invoke(
    "colony:terminal",
    event,
    "list",
    null,
  );
  assert.equal(listResult.ok, true);
  assert.ok(Array.isArray(listResult.result));
  assert.equal(listResult.result.length, 1);
  assert.equal(listResult.result[0].sessionId, started.result.sessionId);
});

test("attach returns replay", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  service.write(started.result.sessionId, "hello");
  const attachResult = await ipcMain.invoke(
    "colony:terminal",
    event,
    "attach",
    { sessionId: started.result.sessionId },
  );
  assert.equal(attachResult.ok, true);
  assert.ok(attachResult.result.replay);
});

test("write and resize work through ipc handler", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  const writeResult = await ipcMain.invoke("colony:terminal", event, "write", {
    sessionId: started.result.sessionId,
    data: "hello",
  });
  assert.equal(writeResult.ok, true);
  const resizeResult = await ipcMain.invoke(
    "colony:terminal",
    event,
    "resize",
    { sessionId: started.result.sessionId, cols: 120, rows: 40 },
  );
  assert.equal(resizeResult.ok, true);
});

test("ack returns ok", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  const ackResult = await ipcMain.invoke("colony:terminal", event, "ack", {
    sessionId: started.result.sessionId,
    bytes: 100,
  });
  assert.equal(ackResult.ok, true);
});

test("close returns ok", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  const closeResult = await ipcMain.invoke("colony:terminal", event, "close", {
    sessionId: started.result.sessionId,
  });
  assert.equal(closeResult.ok, true);
});

test("closeAll returns ok", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  const closeAllResult = await ipcMain.invoke(
    "colony:terminal",
    event,
    "closeAll",
    null,
  );
  assert.equal(closeAllResult.ok, true);
});

test("unknown op returns ok false", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const result = await ipcMain.invoke("colony:terminal", event, "badop", null);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Unknown"));
});

test("service error does not throw from handler", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const result = await ipcMain.invoke("colony:terminal", event, "write", {
    sessionId: "unknown-session-id-xyz",
    data: "x",
  });
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string");
});

test("foreign sender is rejected", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent({ ...webContents, id: 99999 }, 99999);
  const result = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Foreign sender");
});

test("onData sends webContents.send with correct arguments", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  service.write(started.result.sessionId, Buffer.from("hello"));
  assert.equal(webContents.sends.length, 1);
  assert.equal(webContents.sends[0].channel, "colony:terminal:data");
  assert.equal(webContents.sends[0].args[0], started.result.sessionId);
  assert.ok(
    webContents.sends[0].args[1] instanceof Uint8Array ||
      Buffer.isBuffer(webContents.sends[0].args[1]),
  );
});

test("onExit sends webContents.send with correct arguments", async () => {
  const ipcMain = makeFakeIpcMain();
  const webContents = makeFakeWebContents();
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  // Manually trigger exit on the fake pty
  // Since our fake spawn returns a pty with onExit, we can emit through the service's internal reference
  // But the service stores the pty in session. Let's access it directly.
  const session = service.sessions.get(started.result.sessionId);
  if (session?.pty?._emitExit) {
    session.pty._emitExit({ exitCode: 0, signal: null });
  }
  // The service's onData/onExit callbacks should trigger webContents.send
  assert.ok(
    webContents.sends.some((s) => s.channel === "colony:terminal:exit"),
  );
});

test("send skipped when isDestroyed is true", async () => {
  const ipcMain = makeFakeIpcMain();
  let destroyed = false;
  const webContents = {
    id: 12345,
    sends: [],
    isDestroyed: () => destroyed,
    send: (channel, ...args) => webContents.sends.push({ channel, args }),
  };
  const { service } = harness();
  registerTerminalIpc({ ipcMain, webContents, service });
  const event = makeEvent(webContents);
  const started = await ipcMain.invoke("colony:terminal", event, "start", {
    cwd: process.cwd(),
  });
  assert.equal(started.ok, true);
  destroyed = true;
  service.write(started.result.sessionId, "ignored");
  // Since the service's pty doesn't emit data synchronously in our fake, we rely on the send being skipped by the handler
  // We verify by checking that the last send wasn't added after destroying.
  assert.equal(webContents.sends.length, 0);
});
