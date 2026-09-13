import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  EvidenceTransport,
} from "./transport.mjs";

const PRIMARY_URL = "https://cdn.example.com/site/index.html";
const REDIRECT_URL = "https://assets.example.com/site/index.html";
const PRIVATE_URL = "https://127.0.0.1/private.html";

function response({ statusCode = 200, headers = {}, chunks = [] } = {}) {
  let destroyed = false;
  return {
    statusCode,
    headers,
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
    },
    body: (async function* () {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })(),
  };
}

function createSession() {
  let protocolHandler = null;
  let beforeRequest = null;
  let beforeRequestFilter = null;
  let unhandledScheme = null;
  let permissionRequestHandler = null;
  let permissionCheckHandler = null;
  let downloadHandler = null;
  let clearedWebRequest = false;

  const session = {
    protocol: {
      async handle(scheme, handler) {
        assert.equal(scheme, "https");
        protocolHandler = handler;
      },
      async unhandle(scheme) {
        unhandledScheme = scheme;
        protocolHandler = null;
      },
    },
    webRequest: {
      onBeforeRequest(filter, handler) {
        if (filter === null) {
          clearedWebRequest = true;
          beforeRequest = null;
          beforeRequestFilter = null;
          return;
        }
        beforeRequestFilter = filter;
        beforeRequest = handler;
      },
    },
    setPermissionRequestHandler(handler) {
      permissionRequestHandler = handler;
    },
    setPermissionCheckHandler(handler) {
      permissionCheckHandler = handler;
    },
    on(event, handler) {
      if (event === "will-download") downloadHandler = handler;
    },
    removeListener(event, handler) {
      if (event === "will-download" && downloadHandler === handler) {
        downloadHandler = null;
      }
    },
  };

  return {
    session,
    get handler() {
      return protocolHandler;
    },
    get beforeRequest() {
      return beforeRequest;
    },
    get beforeRequestFilter() {
      return beforeRequestFilter;
    },
    get unhandledScheme() {
      return unhandledScheme;
    },
    get permissionRequestHandler() {
      return permissionRequestHandler;
    },
    get permissionCheckHandler() {
      return permissionCheckHandler;
    },
    get downloadHandler() {
      return downloadHandler;
    },
    get clearedWebRequest() {
      return clearedWebRequest;
    },
  };
}

function createWorld({ addresses, routes, openHandler } = {}) {
  const resolvedAddresses = addresses ?? {
    "cdn.example.com": [{ address: "93.184.216.34", family: 4 }],
    "assets.example.com": [{ address: "93.184.216.35", family: 4 }],
  };
  const resolvedRoutes = routes ?? new Map();
  const lookupCalls = [];
  const openCalls = [];
  const dependencies = {
    async lookup(hostname, context) {
      lookupCalls.push({ hostname, context });
      const value = resolvedAddresses[hostname];
      if (value === undefined) {
        throw new Error(`unexpected DNS lookup for ${hostname}`);
      }
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value(hostname, context) : value;
    },
    async open(request) {
      openCalls.push(request);
      if (openHandler) return openHandler(request, openCalls.length - 1);
      const route = resolvedRoutes.get(request.url);
      if (route === undefined) {
        throw new Error(`unexpected HTTPS request for ${request.url}`);
      }
      return route(request);
    },
  };
  return { dependencies, lookupCalls, openCalls };
}

async function createTransport({ worldOptions, ...transportOptions } = {}) {
  const session = createSession();
  const world = createWorld(worldOptions);
  const transport = new EvidenceTransport({
    previewSession: session.session,
    dependencies: world.dependencies,
    ...transportOptions,
  });
  await transport.start();
  return { session, world, transport, handler: session.handler };
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error(message);
}

test("the protocol guard permits credential-free GETs and forwards no body or credentials", async (t) => {
  const routes = new Map([
    [PRIMARY_URL, () => response({ chunks: ["ok"] })],
  ]);
  const environment = await createTransport({ worldOptions: { routes } });
  t.after(() => environment.transport.close());

  assert.deepEqual(environment.session.beforeRequestFilter, {
    urls: ["<all_urls>"],
  });
  const inspect = (details) => {
    let decision;
    environment.session.beforeRequest(details, (value) => {
      decision = value;
    });
    return decision;
  };
  assert.deepEqual(inspect({ url: PRIMARY_URL, method: "GET" }), {
    cancel: false,
  });
  assert.deepEqual(inspect({ url: PRIMARY_URL, method: "POST" }), {
    cancel: true,
  });
  assert.deepEqual(
    inspect({
      url: PRIMARY_URL,
      method: "GET",
      uploadData: [{ bytes: "credential-bearing body" }],
    }),
    { cancel: true },
  );

  const refused = await environment.handler({
    url: PRIMARY_URL,
    method: "POST",
  });
  assert.equal(refused.status, 403);
  assert.equal(environment.world.lookupCalls.length, 0);

  const fetched = await environment.handler({
    url: PRIMARY_URL,
    method: "GET",
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
    },
    uploadData: [{ bytes: "must not reach the network" }],
  });
  // The protocol handler itself does not receive uploadData, so only its
  // policy callback can reject it. A direct GET handler request has no body
  // or credential fields to pass to the pinned dependency.
  assert.equal(fetched.status, 200);
  const networkRequest = environment.world.openCalls[0];
  for (const field of [
    "method",
    "headers",
    "body",
    "uploadData",
    "authorization",
    "cookie",
  ]) {
    assert.equal(
      Object.hasOwn(networkRequest, field),
      false,
      `${field} must not be forwarded to the network dependency`,
    );
  }
});

test("public redirects are re-pinned per hop and private redirect targets are refused", async (t) => {
  const redirect = response({
    statusCode: 302,
    headers: { location: REDIRECT_URL },
  });
  const routes = new Map([
    [PRIMARY_URL, () => redirect],
    [REDIRECT_URL, () => response({ chunks: ["final"] })],
  ]);
  const environment = await createTransport({ worldOptions: { routes } });
  t.after(() => environment.transport.close());

  const firstHop = await environment.handler({
    url: PRIMARY_URL,
    method: "GET",
  });
  assert.equal(firstHop.status, 302);
  assert.equal(firstHop.headers.get("location"), REDIRECT_URL);
  assert.equal(redirect.destroyed, true);
  assert.deepEqual(
    environment.world.lookupCalls.map(({ hostname }) => hostname),
    ["cdn.example.com", "assets.example.com"],
  );
  assert.deepEqual(
    environment.world.openCalls.map(({ url, hostname, address }) => ({
      url,
      hostname,
      address,
    })),
    [
      {
        url: PRIMARY_URL,
        hostname: "cdn.example.com",
        address: "93.184.216.34",
      },
      {
        url: REDIRECT_URL,
        hostname: "assets.example.com",
        address: "93.184.216.35",
      },
    ],
  );
  for (const request of environment.world.openCalls) {
    assert.equal(Object.hasOwn(request, "headers"), false);
  }

  const followed = await environment.handler({
    url: REDIRECT_URL,
    method: "GET",
  });
  assert.equal(followed.status, 200);
  assert.equal(await followed.text(), "final");

  const privateRedirect = response({
    statusCode: 302,
    headers: { location: PRIVATE_URL },
  });
  routes.set(PRIMARY_URL, () => privateRedirect);
  const refused = await environment.handler({
    url: PRIMARY_URL,
    method: "GET",
  });
  assert.equal(refused.status, 502);
  assert.equal(privateRedirect.destroyed, true);
  // The private target fails URL validation before DNS or socket access.
  assert.equal(
    environment.world.lookupCalls.filter(
      ({ hostname }) => hostname === "127.0.0.1",
    ).length,
    0,
  );
});

test("the ninth concurrent resource waits for a slot instead of returning a false 429", async (t) => {
  const openResolvers = [];
  const environment = await createTransport({
    maxRequests: 16,
    maxBytes: 16,
    maxResourceBytes: 1,
    requestTimeoutMs: 1_000,
    worldOptions: {
      openHandler: () =>
        new Promise((resolve) => {
          openResolvers.push(resolve);
        }),
    },
  });
  t.after(() => environment.transport.close());

  const pending = Array.from({ length: 9 }, (_, index) =>
    environment.handler({
      url: `https://cdn.example.com/resource-${index}.txt`,
      method: "GET",
    }),
  );
  await waitUntil(
    () => openResolvers.length === 8,
    "the first eight resources should occupy the transport slots",
  );
  assert.equal(environment.transport.stats().active, 8);
  assert.equal(environment.transport.stats().queued, 1);
  await delay(5);
  assert.equal(openResolvers.length, 8);

  openResolvers[0](response({ chunks: ["a"] }));
  await waitUntil(
    () => openResolvers.length === 9,
    "the queued ninth resource should start after a slot is released",
  );
  for (let index = 1; index < 9; index += 1) {
    openResolvers[index](response({ chunks: ["a"] }));
  }
  const results = await Promise.all(pending);
  assert.equal(results.every((result) => result.status === 200), true);
  assert.deepEqual(environment.transport.stats(), {
    requests: 9,
    bytes: 9,
    maxRequests: 16,
    maxBytes: 16,
    active: 0,
    queued: 0,
  });
});

test("enforces per-resource, total-byte, and request-count limits", async (t) => {
  const oversizedUrl = "https://cdn.example.com/oversized.txt";
  const goodUrl = "https://cdn.example.com/good.txt";
  const routes = new Map([
    [oversizedUrl, () => response({ chunks: ["abc"] })],
    [goodUrl, () => response({ chunks: ["ok"] })],
  ]);
  const environment = await createTransport({
    maxRequests: 2,
    maxBytes: 8,
    maxResourceBytes: 2,
    worldOptions: { routes },
  });
  t.after(() => environment.transport.close());

  const oversized = await environment.handler({
    url: oversizedUrl,
    method: "GET",
  });
  assert.equal(oversized.status, 502);
  assert.equal(environment.transport.stats().bytes, 0);

  const good = await environment.handler({ url: goodUrl, method: "GET" });
  assert.equal(good.status, 200);
  const overRequestBudget = await environment.handler({
    url: goodUrl,
    method: "GET",
  });
  assert.equal(overRequestBudget.status, 429);
  assert.equal(environment.transport.stats().requests, 2);

  const byteRoutes = new Map([
    [goodUrl, () => response({ chunks: ["x"] })],
  ]);
  const byteEnvironment = await createTransport({
    maxRequests: 4,
    maxBytes: 2,
    maxResourceBytes: 1,
    worldOptions: { routes: byteRoutes },
  });
  t.after(() => byteEnvironment.transport.close());
  assert.equal(
    (await byteEnvironment.handler({ url: goodUrl, method: "GET" })).status,
    200,
  );
  assert.equal(
    (await byteEnvironment.handler({ url: goodUrl, method: "GET" })).status,
    200,
  );
  const overByteBudget = await byteEnvironment.handler({
    url: goodUrl,
    method: "GET",
  });
  assert.equal(overByteBudget.status, 429);
  assert.equal(byteEnvironment.transport.stats().bytes, 2);
});

test("close aborts an in-flight request, drains queued work, and blocks new requests", async (t) => {
  let requestSignal = null;
  const environment = await createTransport({
    maxRequests: 4,
    maxBytes: 1,
    maxResourceBytes: 1,
    requestTimeoutMs: 1_000,
    worldOptions: {
      openHandler: (request) => {
        requestSignal = request.signal;
        return new Promise(() => {});
      },
    },
  });
  t.after(() => environment.transport.close());

  const inFlight = environment.handler({ url: PRIMARY_URL, method: "GET" });
  await waitUntil(
    () => requestSignal !== null,
    "the in-flight request should reach the pinned dependency",
  );
  const queued = environment.handler({
    url: "https://cdn.example.com/queued.html",
    method: "GET",
  });
  await waitUntil(
    () => environment.transport.stats().queued === 1,
    "the second request should be queued behind the in-flight request",
  );

  await environment.transport.close();
  assert.equal(requestSignal.aborted, true);
  const [inFlightResponse, queuedResponse] = await Promise.all([
    inFlight,
    queued,
  ]);
  assert.equal(inFlightResponse.status, 502);
  assert.equal(queuedResponse.status, 429);
  assert.equal(environment.transport.stats().active, 0);
  assert.equal(environment.transport.stats().queued, 0);
  assert.equal(environment.session.unhandledScheme, "https");
  assert.equal(environment.session.clearedWebRequest, true);

  const afterClose = await environment.handler({
    url: PRIMARY_URL,
    method: "GET",
  });
  assert.equal(afterClose.status, 410);
});
