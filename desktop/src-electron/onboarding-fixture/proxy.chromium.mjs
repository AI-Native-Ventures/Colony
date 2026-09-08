// Real browser integration: run explicitly after Playwright Chromium is installed.
// Keep outside the *.test.mjs unit glob so Desktop Core needs no browser binary.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "@playwright/test";
import { createOnboardingFixtureProxy } from "./proxy.mjs";

test("real Chromium HTTPS/WSS uses exact canonical hosts and only this leaf pin", {
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "colony-tls-proxy-test-"),
  );
  const seen = [];
  const sockets = new Set();
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({
      host: request.headers.host,
      path: request.url,
      auth: request.headers.authorization,
      body,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ host: request.headers.host }));
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  upstream.on("upgrade", (request, socket) => {
    seen.push({ host: request.headers.host, path: request.url });
    const accept = createHash("sha1")
      .update(
        request.headers["sec-websocket-key"] +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const body = Buffer.from("real websocket tunnel");
    socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
    socket.on("data", () => socket.end());
  });
  let proxy;
  let browser;
  let rejectedBrowser;
  try {
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = await createOnboardingFixtureProxy({
      domain: "onboarding-transporttest.invalid",
      upstreamHttpUrl: `http://127.0.0.1:${upstream.address().port}`,
      directory,
    });
    assert.deepEqual(
      await readdir(directory),
      [],
      "private CA/leaf key files must already be removed",
    );
    browser = await chromium.launch({
      headless: true,
      args: proxy.chromiumArgs,
    });
    const page = await browser.newPage();
    const response = await page.goto(`${proxy.bootstrapHttpUrl}/probe`, {
      timeout: 10_000,
    });
    assert.equal((await response.json()).host, proxy.bootstrapHost);
    await page.evaluate(async () => {
      const response = await fetch("/echo?private=do-not-log", {
        method: "POST",
        headers: {
          Authorization: "synthetic-token",
          "content-type": "application/json",
        },
        body: '{"sensitive":"synthetic-body"}',
      });
      if (!response.ok) throw new Error("echo failed");
    });
    assert.ok(
      seen.some(
        (request) =>
          request.body === '{"sensitive":"synthetic-body"}' &&
          request.auth === "synthetic-token" &&
          request.path === "/echo?private=do-not-log",
      ),
    );
    const content = await page.evaluate(
      (url) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`${url}/relay?scope=fixture`);
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("WSS fixture timed out"));
          }, 10_000);
          socket.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
            socket.close();
          };
          socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error("WSS fixture failed"));
          };
        }),
      proxy.businessRelayUrl,
    );
    assert.equal(content, "real websocket tunnel");
    assert.ok(
      seen.some(
        (request) =>
          request.host === proxy.businessHost &&
          request.path === "/relay?scope=fixture",
      ),
    );
    assert.ok(!JSON.stringify(proxy.requests).includes("synthetic-token"));
    assert.ok(!JSON.stringify(proxy.requests).includes("synthetic-body"));
    assert.ok(!JSON.stringify(proxy.requests).includes("do-not-log"));
    const unknown = await page
      .goto("https://unlisted.onboarding-transporttest.invalid/", {
        timeout: 5_000,
      })
      .catch((error) => error);
    assert.ok(
      unknown instanceof Error && /ERR_NAME_NOT_RESOLVED/.test(unknown.message),
    );
    rejectedBrowser = await chromium.launch({
      headless: true,
      args: proxy.chromiumArgs.map((arg) =>
        arg.startsWith("--ignore-certificate-errors-spki-list=")
          ? `--ignore-certificate-errors-spki-list=${Buffer.alloc(32).toString("base64")}`
          : arg,
      ),
    });
    const rejected = await rejectedBrowser.newPage();
    const badPin = await rejected
      .goto(`${proxy.bootstrapHttpUrl}/wrong-pin`, { timeout: 10_000 })
      .catch((error) => error);
    assert.ok(
      badPin instanceof Error &&
        /ERR_CERT_AUTHORITY_INVALID/.test(badPin.message),
    );
    assert.ok(!seen.some((request) => request.path === "/wrong-pin"));
    // Native-style CA verification succeeds, but mixed SNI/Host is still refused.
    const config = JSON.parse(proxy.transportConfig);
    const address = new URL(`http://${config.routes[0].address}`);
    const ca = new X509Certificate(
      Buffer.from(config.ca_der_base64, "base64"),
    ).toString();
    const status = await new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          servername: proxy.bootstrapHost,
          ca,
          headers: { Host: proxy.businessHost },
          path: "/mixed-authority",
          agent: false,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 421);
    assert.ok(!seen.some((request) => request.path === "/mixed-authority"));
  } finally {
    await rejectedBrowser?.close();
    await browser?.close();
    await proxy?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
