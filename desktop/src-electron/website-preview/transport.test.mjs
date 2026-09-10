import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import {
  fetchBoundBytes,
  loadWebsitePreview,
  MAX_DEADLINE_MS,
  MAX_MAX_REDIRECTS,
  MAX_TIMEOUT_MS,
  PREVIEW_SCHEMA,
  sha256Hex,
} from "./artifact.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";
const MANIFEST_URL = "https://cdn.example.com/site/manifest.json";

function bytes(value) {
  return Buffer.from(value, "utf8");
}

function fileEntry(path, content, options = {}) {
  const contentBytes = Buffer.isBuffer(content)
    ? content
    : bytes(content ?? path);
  return {
    path,
    url: options.url ?? `https://cdn.example.com/assets/${path}`,
    sha256: options.sha256 ?? sha256Hex(contentBytes),
    mime: options.mime ?? "text/html",
    size: options.size ?? contentBytes.byteLength,
  };
}

function manifestBytes(files, overrides = {}) {
  return bytes(
    JSON.stringify({
      schema: PREVIEW_SCHEMA,
      entrypoint: "index.html",
      files,
      ...overrides,
    }),
  );
}

function reply(options = {}) {
  const {
    status = 200,
    headers = {},
    chunks = [],
    hangAfterChunks = false,
  } = options;
  const state = { destroyed: false };
  return {
    statusCode: status,
    headers,
    get destroyed() {
      return state.destroyed;
    },
    destroy() {
      state.destroyed = true;
    },
    body: (async function* () {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
      if (hangAfterChunks) await new Promise(() => {});
    })(),
  };
}

function createWorld(options = {}) {
  const addresses = options.addresses ?? {
    "cdn.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
  };
  const routes = options.routes ?? new Map();
  const lookupCalls = [];
  const openCalls = [];
  const dependencies = {
    async lookup(hostname, context) {
      lookupCalls.push({ hostname, context });
      const value = addresses[hostname];
      if (value === undefined) {
        throw new Error(`unexpected lookup for ${hostname}`);
      }
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value(hostname, context);
      return value;
    },
    async open(request) {
      openCalls.push(request);
      const handler = routes.get(request.url);
      if (handler === undefined) {
        throw Object.assign(new Error(`no route for ${request.url}`), {
          code: "ENOTFOUND",
        });
      }
      return handler(request);
    },
  };
  return { addresses, routes, lookupCalls, openCalls, dependencies };
}

function manifestRef(world, body, url = MANIFEST_URL) {
  world.routes.set(url, () => reply({ chunks: [body] }));
  return { url, sha256: sha256Hex(body) };
}

async function expectCode(operation, code, check) {
  await assert.rejects(operation, (error) => {
    assert.equal(
      error?.code,
      code,
      `expected code ${code}, got ${error?.code}: ${error?.message}`,
    );
    check?.(error);
    return true;
  });
}

test("bounds a hung DNS lookup with the per-request timeout", async () => {
  const world = createWorld();
  world.addresses["cdn.example.com"] = () => new Promise(() => {});
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      timeoutMs: 40,
      deadlineMs: 5_000,
    }),
    "timeout",
    (error) => assert.equal(error.details?.reason, "request_timeout"),
  );
  assert.equal(world.lookupCalls.length, 1);
  assert.equal(world.openCalls.length, 0);
});

test("bounds a hung DNS lookup with the total load deadline", async () => {
  const world = createWorld();
  world.addresses["cdn.example.com"] = () => new Promise(() => {});
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      timeoutMs: 5_000,
      deadlineMs: 30,
    }),
    "timeout",
    (error) => {
      assert.equal(error.details?.reason, "deadline");
      assert.equal(error.details?.deadlineMs, 30);
    },
  );
  assert.equal(world.openCalls.length, 0);
});

test("bounds a connection that never produces a response", async () => {
  const world = createWorld();
  const entry = fileEntry("index.html", "x");
  const ref = manifestRef(world, manifestBytes([entry]));
  world.routes.set(ref.url, () => new Promise(() => {}));

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      timeoutMs: 30,
      deadlineMs: 5_000,
    }),
    "timeout",
    (error) => assert.equal(error.details?.reason, "request_timeout"),
  );
  assert.equal(world.openCalls.length, 1);
  assert.equal(world.openCalls[0].signal?.aborted, true);
});

test("bounds a body that trickles and then stalls", async () => {
  const entry = fileEntry("index.html", "0123456789", { size: 10 });
  const world = createWorld();
  const ref = manifestRef(world, manifestBytes([entry]));
  const response = reply({ chunks: ["0123"], hangAfterChunks: true });
  world.routes.set(entry.url, () => response);

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      timeoutMs: 30,
      deadlineMs: 5_000,
    }),
    "timeout",
    (error) => assert.equal(error.details?.reason, "request_timeout"),
  );
  assert.equal(response.destroyed, true);
});

test("honors an already-aborted caller signal before any network work", async () => {
  const world = createWorld();
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));
  const controller = new AbortController();
  controller.abort();

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      signal: controller.signal,
    }),
    "aborted",
  );
  assert.equal(world.lookupCalls.length, 0);
  assert.equal(world.openCalls.length, 0);
});

test("aborts during lookup and never opens a connection for a late answer", async () => {
  const world = createWorld();
  let releaseLookup;
  world.addresses["cdn.example.com"] = () =>
    new Promise((resolve) => {
      releaseLookup = resolve;
    });
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));
  const controller = new AbortController();

  const pending = loadWebsitePreview({
    manifestRef: ref,
    dependencies: world.dependencies,
    signal: controller.signal,
  });
  while (releaseLookup === undefined) await delay(1);
  controller.abort();
  await expectCode(pending, "aborted");

  releaseLookup([{ address: PUBLIC_ADDRESS, family: 4 }]);
  await delay(10);
  assert.equal(world.openCalls.length, 0);
});

test("aborts while streaming a body and destroys the response", async () => {
  const entry = fileEntry("index.html", "0123456789", { size: 10 });
  const world = createWorld();
  const ref = manifestRef(world, manifestBytes([entry]));
  const response = reply({ chunks: ["0123"], hangAfterChunks: true });
  world.routes.set(entry.url, () => response);
  const controller = new AbortController();

  const pending = loadWebsitePreview({
    manifestRef: ref,
    dependencies: world.dependencies,
    signal: controller.signal,
    timeoutMs: 5_000,
    deadlineMs: 10_000,
  });
  while (world.openCalls.length < 2) await delay(1);
  controller.abort();
  await expectCode(pending, "aborted");
  assert.equal(response.destroyed, true);
});

test("destroys a response that arrives after the request timed out", async () => {
  const world = createWorld();
  let releaseOpen;
  const lateResponse = reply({ chunks: [bytes("late")] });
  world.routes.set(
    MANIFEST_URL,
    () =>
      new Promise((resolve) => {
        releaseOpen = () => resolve(lateResponse);
      }),
  );

  const pending = fetchBoundBytes(MANIFEST_URL, {
    dependencies: world.dependencies,
    maxBytes: 1024,
    timeoutMs: 25,
    deadlineMs: 5_000,
  });
  while (releaseOpen === undefined) await delay(1);
  await expectCode(pending, "timeout");

  releaseOpen();
  await delay(10);
  assert.equal(lateResponse.destroyed, true);
});

test("destroys a late response and leaks no rejection after a caller abort", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const world = createWorld();
    let releaseOpen;
    const lateResponse = reply({ chunks: [bytes("late")] });
    world.routes.set(
      MANIFEST_URL,
      () =>
        new Promise((resolve) => {
          releaseOpen = () => resolve(lateResponse);
        }),
    );
    const controller = new AbortController();

    const pending = fetchBoundBytes(MANIFEST_URL, {
      dependencies: world.dependencies,
      maxBytes: 1024,
      signal: controller.signal,
      timeoutMs: 5_000,
      deadlineMs: 10_000,
    });
    while (releaseOpen === undefined) await delay(1);
    controller.abort();
    await expectCode(pending, "aborted");

    releaseOpen();
    await delay(20);
    assert.equal(lateResponse.destroyed, true);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
});

test("rejects invalid timeout, deadline, redirect, and signal options", async () => {
  const world = createWorld();
  const cases = [
    [{ timeoutMs: 0 }, "invalid_timeout"],
    [{ timeoutMs: -1 }, "invalid_timeout"],
    [{ timeoutMs: 1.5 }, "invalid_timeout"],
    [{ timeoutMs: "15000" }, "invalid_timeout"],
    [{ timeoutMs: Number.MAX_SAFE_INTEGER + 2 }, "invalid_timeout"],
    [{ timeoutMs: MAX_TIMEOUT_MS + 1 }, "invalid_timeout"],
    [{ timeoutMs: Number.POSITIVE_INFINITY }, "invalid_timeout"],
    [{ deadlineMs: 0 }, "invalid_deadline"],
    [{ deadlineMs: 1.5 }, "invalid_deadline"],
    [{ deadlineMs: MAX_DEADLINE_MS + 1 }, "invalid_deadline"],
    [{ maxRedirects: -1 }, "invalid_redirects"],
    [{ maxRedirects: 1.5 }, "invalid_redirects"],
    [{ maxRedirects: MAX_MAX_REDIRECTS + 1 }, "invalid_redirects"],
    [{ signal: {} }, "invalid_signal"],
    [{ signal: "abort" }, "invalid_signal"],
  ];
  for (const [overrides, code] of cases) {
    await expectCode(
      fetchBoundBytes(MANIFEST_URL, {
        dependencies: world.dependencies,
        maxBytes: 1024,
        ...overrides,
      }),
      code,
    );
  }

  await expectCode(
    loadWebsitePreview({
      manifestRef: { url: MANIFEST_URL, sha256: sha256Hex(bytes("x")) },
      dependencies: world.dependencies,
      timeoutMs: 0,
    }),
    "invalid_timeout",
  );

  assert.equal(world.lookupCalls.length, 0);
  assert.equal(world.openCalls.length, 0);
});

test("accepts boundary timeout, deadline, and redirect values", async () => {
  const world = createWorld();
  const body = manifestBytes([fileEntry("index.html", "x")]);
  world.routes.set(MANIFEST_URL, () => reply({ chunks: [body] }));

  const result = await fetchBoundBytes(MANIFEST_URL, {
    dependencies: world.dependencies,
    maxBytes: 1024,
    timeoutMs: MAX_TIMEOUT_MS,
    deadlineMs: MAX_DEADLINE_MS,
    maxRedirects: MAX_MAX_REDIRECTS,
  });
  assert.deepEqual(result.bytes, body);
  assert.equal(result.redirects, 0);
});

test("keeps timeout, abort, and dependency failures in their own codes", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);

  const aborting = createWorld();
  const abortingRef = manifestRef(aborting, body);
  aborting.dependencies.open = async () => {
    throw Object.assign(new Error("canceled"), { name: "AbortError" });
  };
  await expectCode(
    loadWebsitePreview({
      manifestRef: abortingRef,
      dependencies: aborting.dependencies,
    }),
    "aborted",
  );

  const timingOut = createWorld();
  const timingOutRef = manifestRef(timingOut, body);
  timingOut.dependencies.open = async () => {
    const error = new Error("socket stalled");
    error.code = "preview_timeout";
    throw error;
  };
  await expectCode(
    loadWebsitePreview({
      manifestRef: timingOutRef,
      dependencies: timingOut.dependencies,
    }),
    "timeout",
  );

  const failing = createWorld();
  const failingRef = manifestRef(failing, body);
  failing.dependencies.open = async () => {
    throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
  };
  await expectCode(
    loadWebsitePreview({
      manifestRef: failingRef,
      dependencies: failing.dependencies,
    }),
    "request_failed",
  );
});
