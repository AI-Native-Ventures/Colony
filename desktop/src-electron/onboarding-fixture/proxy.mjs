// A transport adapter only: account and provisioning responses come from the
// real isolated relay. Canonical request URLs, Host, auth and bodies stay intact.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { createSecureContext } from "node:tls";
import path from "node:path";
import { createFixtureCertificates } from "./certificates.mjs";
import {
  observeEventRequest,
  observeEventResponse,
} from "./failure-diagnostics.mjs";

function loopbackUpstream(value) {
  const url = new URL(value);
  assert.ok(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password,
    "Fixture upstream must be an explicit loopback HTTP listener",
  );
  return url;
}

/** Start exact bootstrap/business/model TLS routes to already-owned local services. */
export async function createOnboardingFixtureProxy({
  domain,
  upstreamHttpUrl,
  modelUpstreamHttpUrl,
  directory,
}) {
  assert.match(domain, /^onboarding-[a-z0-9]+\.invalid$/);
  assert.ok(path.isAbsolute(directory), "Fixture directory must be absolute");
  const bootstrapHost = `bootstrap.${domain}`;
  const businessHost = `horizon-labs.${domain}`;
  const modelHost = `model.${domain}`;
  const relay = loopbackUpstream(upstreamHttpUrl);
  const routes = new Map([
    [bootstrapHost, relay],
    [businessHost, relay],
  ]);
  if (modelUpstreamHttpUrl)
    routes.set(modelHost, loopbackUpstream(modelUpstreamHttpUrl));
  const hosts = [...routes.keys()];
  const certificates = await createFixtureCertificates(directory, hosts);
  const context = createSecureContext({
    key: certificates.key,
    cert: certificates.cert,
  });
  const requests = [];
  const sockets = new Set();
  const pending = new Set();
  const remember = (request, status) => {
    const entry = {
      method: [
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "OPTIONS",
        "HEAD",
      ].includes(request.method)
        ? request.method
        : "OTHER",
      host: routes.has(request.headers.host)
        ? request.headers.host
        : "<unmapped>",
      // Query values, headers and bodies can contain credentials. Never retain them.
      path: new URL(request.url, "https://fixture.invalid").pathname,
      status,
    };
    if (requests.length >= 2_000)
      throw new Error("Fixture request log limit exceeded");
    requests.push(entry);
    return entry;
  };
  const resolve = (request) => {
    if (!request.url?.startsWith("/") || request.url.startsWith("//"))
      return null;
    const host = request.headers.host;
    if (!routes.has(host) || request.socket.servername !== host) return null;
    return routes.get(host);
  };
  const options = (request, upstream) => ({
    hostname: "127.0.0.1",
    port: Number(upstream.port),
    method: request.method,
    path: request.url,
    headers: request.headers,
    agent: false,
  });
  const track = (socket) => {
    if (sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const server = createServer(
    {
      key: certificates.key,
      cert: certificates.cert,
      minVersion: "TLSv1.2",
      maxHeaderSize: 32 * 1024,
      SNICallback(host, done) {
        done(
          routes.has(host) ? null : new Error("Unmapped fixture SNI"),
          routes.has(host) ? context : undefined,
        );
      },
    },
    (request, response) => {
      const upstream = resolve(request);
      if (!upstream || requests.length >= 2_000) {
        response.writeHead(421).end();
        return;
      }
      const entry = remember(request, null);
      const observeEvent =
        entry.host === businessHost &&
        entry.path === "/events" &&
        entry.method === "POST";
      if (observeEvent) {
        entry.eventRequest = { unavailable: "request-pending" };
        observeEventRequest(request, (value) => {
          entry.eventRequest = value;
        });
      }
      const forwarded = httpRequest(options(request, upstream), (result) => {
        entry.status = result.statusCode;
        if (observeEvent) {
          entry.eventResponse = { unavailable: "response-pending" };
          observeEventResponse(result, (value) => {
            entry.eventResponse = value;
          });
        }
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
        result.once("error", () => response.destroy());
      });
      pending.add(forwarded);
      forwarded.once("close", () => pending.delete(forwarded));
      forwarded.setTimeout(30_000, () => forwarded.destroy());
      forwarded.once("error", () => {
        entry.status ??= 502;
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          entry.status = 413;
          forwarded.destroy();
          response.destroy();
        }
      });
      request.once("aborted", () => forwarded.destroy());
      response.once("close", () => {
        if (!response.writableFinished) forwarded.destroy();
      });
      request.pipe(forwarded);
    },
  );
  server.on("connection", track);
  server.on("upgrade", (request, socket, head) => {
    const upstream = resolve(request);
    if (
      !upstream ||
      requests.length >= 2_000 ||
      request.headers.upgrade?.toLowerCase() !== "websocket"
    ) {
      socket.destroy();
      return;
    }
    const entry = remember(request, null);
    const forwarded = httpRequest(options(request, upstream));
    pending.add(forwarded);
    forwarded.once("close", () => pending.delete(forwarded));
    forwarded.setTimeout(10_000, () => forwarded.destroy());
    forwarded.once("upgrade", (response, target, targetHead) => {
      forwarded.setTimeout(0);
      target.setTimeout(0);
      track(target);
      entry.status = response.statusCode;
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        headers.push(
          `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`,
        );
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length) target.write(head);
      if (targetHead.length) socket.write(targetHead);
      socket.pipe(target).pipe(socket);
      socket.once("error", () => target.destroy());
      target.once("error", () => socket.destroy());
      socket.once("close", () => target.destroy());
      target.once("close", () => socket.destroy());
    });
    forwarded.once("response", (response) => {
      entry.status = response.statusCode;
      response.destroy();
      socket.destroy();
    });
    forwarded.once("error", () => {
      entry.status ??= 502;
      socket.destroy();
    });
    forwarded.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    certificates.key.fill(0);
    throw error;
  }
  const address = `127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    bootstrapHost,
    businessHost,
    modelHost,
    bootstrapHttpUrl: `https://${bootstrapHost}`,
    businessRelayUrl: `wss://${businessHost}`,
    modelHttpUrl: modelUpstreamHttpUrl ? `https://${modelHost}` : null,
    transportConfig: JSON.stringify({
      version: 1,
      ca_der_base64: certificates.caDerBase64,
      routes: hosts.map((host) => ({ host, address })),
    }),
    // Exact-key exception only. Rust tests independently prove CA/hostname checks.
    // The launcher also needs an exact-origin webRequest deny guard: literal IPs
    // bypass DNS rules. No response interception belongs in this fixture.
    chromiumArgs: [
      `--host-resolver-rules=${hosts.map((host) => `MAP ${host} ${address}`).join(", ")}, MAP * ~NOTFOUND`,
      `--ignore-certificate-errors-spki-list=${certificates.leafSpki}`,
      "--no-proxy-server",
    ],
    requests,
    async close() {
      if (closed) return;
      closed = true;
      for (const request of pending) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      certificates.key.fill(0);
    },
  };
}
