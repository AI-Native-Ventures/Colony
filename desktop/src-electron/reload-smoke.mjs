import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** Exercise real Rust websocket channels and native events across a renderer reload. */
export async function verifyReload(page) {
  const sockets = new Set();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    // A minimal local test peer: upgrade, send one short text frame, accept close.
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (bytes) => {
      if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
    const text = Buffer.from(
      request.url === "/before" ? "old-generation" : "new-generation",
    );
    socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `ws://127.0.0.1:${server.address().port}`;
  const connect = (url) =>
    page.evaluate(async (url) => {
      const api = window.colonyDesktop;
      window.__reloadProofMessages = [];
      api.subscribe((message) => window.__reloadProofMessages.push(message));
      const subscription = await api.request("listen", {
        event: "reload-fixture",
      });
      await api.request("invoke", {
        command: "plugin:websocket|connect",
        args: { url, onMessage: "__CHANNEL__:900001" },
      });
      return subscription;
    }, url);
  try {
    const before = await connect(`${base}/before`);
    await page.waitForFunction(() =>
      window.__reloadProofMessages.some(
        (m) =>
          m.type === "channel" &&
          m.id === 900001 &&
          m.payload?.data === "old-generation",
      ),
    );
    assert.equal(sockets.size, 1);
    await page.reload();
    await page
      .getByText("Inbox", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();
    // An invoke after load must wait for native cleanup before the new page resumes.
    await page.evaluate(() =>
      window.colonyDesktop.request("invoke", { command: "get_identity" }),
    );
    for (let i = 0; i < 50 && sockets.size > 0; i++) await delay(100);
    assert.equal(
      sockets.size,
      0,
      "renderer reload must close old native sockets",
    );
    const after = await connect(`${base}/after`);
    assert.notEqual(before, after);
    await page.waitForFunction(() =>
      window.__reloadProofMessages.some(
        (m) =>
          m.type === "channel" &&
          m.id === 900001 &&
          m.sequence === 0 &&
          m.payload?.data === "new-generation",
      ),
    );
    await page.evaluate(() =>
      window.colonyDesktop.request("emit", {
        event: "reload-fixture",
        payload: "fresh-event",
      }),
    );
    const deliveries = await page.evaluate(() =>
      window.__reloadProofMessages
        .filter((m) => m.type === "event" && m.payload === "fresh-event")
        .map((m) => m.id),
    );
    assert.deepEqual(
      deliveries,
      [after],
      "retired subscriptions must not reach the new renderer",
    );
    await page.evaluate(async (subscription) => {
      await window.colonyDesktop.request("unlisten", { subscription });
      await window.colonyDesktop.request("invoke", {
        command: "plugin:websocket|disconnect_all",
      });
    }, after);
    console.log(
      "Real native websocket/event cleanup across renderer reload: PASS",
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}
