import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHttpsRequestOptions,
  createAuthorizedDependencies,
  isPrivateAddress,
  loadWebsitePreview,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  parsePreviewManifest,
  PREVIEW_SCHEMA,
  sha256Hex,
} from "./artifact.mjs";
import { PreviewArtifactError } from "./errors.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";
const OTHER_ADDRESS = "93.184.216.35";
const MANIFEST_URL = "https://cdn.example.com/site/manifest.json";
const RELAY_ORIGIN = "https://relay.example.com";
const MEDIA_HASH =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const VECTORS_PATH = fileURLToPath(
  new URL(
    "../../../crates/buzz-core/testdata/website/preview_manifest_vectors.json",
    import.meta.url,
  ),
);

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
  const { status = 200, headers = {}, chunks = [], error = null } = options;
  return {
    statusCode: status,
    headers,
    destroy() {},
    body: (async function* () {
      if (error !== null) throw error;
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })(),
  };
}

function redirect(status, location) {
  return reply({ status, headers: { location } });
}

function createWorld(options = {}) {
  const addresses = options.addresses ?? {
    "cdn.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
  };
  const routes = options.routes ?? new Map();
  const calls = [];
  const dependencies = {
    async lookup(hostname) {
      const value = addresses[hostname];
      if (value === undefined)
        throw new Error(`unexpected lookup for ${hostname}`);
      if (value instanceof Error) throw value;
      return value;
    },
    async open(request) {
      calls.push(request);
      const handler = routes.get(request.url);
      if (handler === undefined) {
        throw Object.assign(new Error(`no route for ${request.url}`), {
          code: "ENOTFOUND",
        });
      }
      return handler(request);
    },
  };
  return { addresses, routes, calls, dependencies };
}

function manifestRef(world, body, url = MANIFEST_URL) {
  world.routes.set(url, () => reply({ chunks: [body] }));
  return { url, sha256: sha256Hex(body) };
}

async function expectCode(operation, code) {
  // Accept both shapes: a thunk (wrap it so a synchronous throw becomes a
  // rejection `assert.rejects` can validate) and an already-created promise
  // (pass it through unchanged).
  const rejection =
    typeof operation === "function"
      ? Promise.resolve().then(operation)
      : operation;
  await assert.rejects(rejection, (error) => {
    assert.ok(
      error instanceof PreviewArtifactError,
      `expected PreviewArtifactError, got ${error?.name}: ${error?.message}`,
    );
    assert.equal(
      error?.code,
      code,
      `expected code ${code}, got ${error?.code}: ${error?.message}`,
    );
    return true;
  });
}

test("loads and verifies an immutable preview", async () => {
  const html = bytes("<!doctype html><title>hi</title>");
  const css = bytes("body { color: red }");
  const world = createWorld();
  const index = fileEntry("index.html", html);
  const style = fileEntry("assets/app.css", css, { mime: "text/css" });
  const ref = manifestRef(world, manifestBytes([index, style]));
  world.routes.set(index.url, () => reply({ chunks: [html] }));
  world.routes.set(style.url, () => reply({ chunks: [css] }));

  const site = await loadWebsitePreview({
    manifestRef: ref,
    dependencies: world.dependencies,
  });

  assert.equal(site.schema, PREVIEW_SCHEMA);
  assert.equal(site.entrypoint, "index.html");
  assert.equal(site.manifestSha256, ref.sha256);
  assert.ok(Object.isFrozen(site));
  assert.ok(Object.isFrozen(site.files));
  assert.equal(site.files.length, 2);
  assert.deepEqual(site.getFile("assets/app.css").bytes, css);
  assert.equal(site.getFile("missing.html"), null);
  assert.equal(site.getFile(42), null);
  assert.equal(site.entrypointFile.path, "index.html");
  assert.ok(Object.isFrozen(site.entrypointFile));
  assert.equal(world.calls.length, 3);
  for (const call of world.calls) {
    assert.deepEqual(Object.keys(call).sort(), [
      "address",
      "family",
      "hostname",
      "signal",
      "timeoutMs",
      "url",
    ]);
    assert.equal(call.address, PUBLIC_ADDRESS);
    assert.equal(call.signal?.aborted, false);
  }
});

test("loads a private Blossom manifest and files through the authorized host reader", async () => {
  const html = bytes("<!doctype html><title>private preview</title>");
  const css = bytes("body { color: #147d70 }");
  const manifestUrl = `${RELAY_ORIGIN}/media/${MEDIA_HASH}.json`;
  const indexUrl = `${RELAY_ORIGIN}/media/${MEDIA_HASH}.html`;
  const styleUrl = `${RELAY_ORIGIN}/media/${MEDIA_HASH}.css`;
  const index = fileEntry("index.html", html, { url: indexUrl });
  const style = fileEntry("assets/app.css", css, {
    url: styleUrl,
    mime: "text/css",
  });
  const manifest = manifestBytes([index, style]);
  const bodies = new Map([
    [manifestUrl, manifest],
    [indexUrl, html],
    [styleUrl, css],
  ]);
  const world = createWorld({
    addresses: {
      "relay.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
    },
  });
  const authorizedCalls = [];
  const dependencies = createAuthorizedDependencies({
    relayOrigin: RELAY_ORIGIN,
    dependencies: world.dependencies,
    fetchMediaBytes: async (url) => {
      authorizedCalls.push(url);
      const body = bodies.get(url);
      if (body === undefined) throw new Error("unexpected private artifact");
      return { bytes: body };
    },
  });

  const site = await loadWebsitePreview({
    manifestRef: { url: manifestUrl, sha256: sha256Hex(manifest) },
    dependencies,
  });

  assert.equal(site.entrypointFile.url, indexUrl);
  assert.deepEqual(site.getFile("index.html").bytes, html);
  assert.deepEqual(site.getFile("assets/app.css").bytes, css);
  assert.deepEqual(authorizedCalls, [manifestUrl, indexUrl, styleUrl]);
  assert.equal(world.calls.length, 0);
});

test("rejects a manifest whose raw bytes do not match the ref", async () => {
  const world = createWorld();
  const body = manifestBytes([fileEntry("index.html", "x")]);
  world.routes.set(MANIFEST_URL, () => reply({ chunks: [body] }));
  const ref = { url: MANIFEST_URL, sha256: sha256Hex(bytes("something else")) };

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "digest_mismatch",
  );
});

test("rejects a file whose bytes do not match its digest", async () => {
  const world = createWorld();
  const entry = fileEntry("index.html", "x", { sha256: sha256Hex(bytes("y")) });
  const ref = manifestRef(world, manifestBytes([entry]));
  world.routes.set(entry.url, () => reply({ chunks: [bytes("x")] }));

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "digest_mismatch",
  );
});

test("rejects a file whose body length differs from the declared size", async () => {
  const world = createWorld();
  const entry = fileEntry("index.html", "x", { size: 5 });
  const ref = manifestRef(world, manifestBytes([entry]));
  world.routes.set(entry.url, () => reply({ chunks: [bytes("x")] }));

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "size_mismatch",
  );
});

test("bounds a file body even without Content-Length", async () => {
  const world = createWorld();
  const entry = fileEntry("index.html", "x", {
    sha256: sha256Hex(bytes("12345678")),
    size: 4,
  });
  const ref = manifestRef(world, manifestBytes([entry]));
  world.routes.set(entry.url, () =>
    reply({ chunks: [bytes("1234"), bytes("5678")] }),
  );

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "body_too_large",
  );
  assert.equal(world.calls.length, 2);
});

test("bounds the raw manifest body", async () => {
  const world = createWorld();
  const oversized = Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20);
  const ref = manifestRef(world, oversized);

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "body_too_large",
  );
});

test("rejects a manifest host that resolves to a private address", async () => {
  const world = createWorld({
    addresses: { "cdn.example.com": [{ address: "10.0.0.7", family: 4 }] },
  });
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "dns_blocked",
  );
  assert.equal(world.calls.length, 0);
});

test("rejects an IPv4-mapped loopback resolution", async () => {
  const world = createWorld({
    addresses: {
      "cdn.example.com": [{ address: "::ffff:127.0.0.1", family: 6 }],
    },
  });
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "dns_blocked",
  );
});

test("rejects a mixed resolution containing any blocked address", async () => {
  const world = createWorld({
    addresses: {
      "cdn.example.com": [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    },
  });
  const ref = manifestRef(world, manifestBytes([fileEntry("index.html", "x")]));

  await expectCode(
    loadWebsitePreview({ manifestRef: ref, dependencies: world.dependencies }),
    "dns_blocked",
  );
  assert.equal(world.calls.length, 0);
});

test("reports DNS failures and empty answers", async () => {
  const failing = createWorld({
    addresses: { "cdn.example.com": new Error("ENOTFOUND") },
  });
  const failingRef = manifestRef(
    failing,
    manifestBytes([fileEntry("index.html", "x")]),
  );
  await expectCode(
    loadWebsitePreview({
      manifestRef: failingRef,
      dependencies: failing.dependencies,
    }),
    "dns_failed",
  );

  const empty = createWorld({ addresses: { "cdn.example.com": [] } });
  const emptyRef = manifestRef(
    empty,
    manifestBytes([fileEntry("index.html", "x")]),
  );
  await expectCode(
    loadWebsitePreview({
      manifestRef: emptyRef,
      dependencies: empty.dependencies,
    }),
    "dns_empty",
  );
});

test("re-resolves and re-pins every redirect hop", async () => {
  const html = bytes("ok");
  const entry = fileEntry("index.html", html);
  const body = manifestBytes([entry]);
  const world = createWorld({
    addresses: {
      "cdn.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
      "other.example.com": [{ address: OTHER_ADDRESS, family: 4 }],
    },
    routes: new Map([
      [
        "https://cdn.example.com/start",
        () => redirect(302, "https://other.example.com/final"),
      ],
      ["https://other.example.com/final", () => reply({ chunks: [body] })],
      [entry.url, () => reply({ chunks: [html] })],
    ]),
  });
  const ref = { url: "https://cdn.example.com/start", sha256: sha256Hex(body) };

  const site = await loadWebsitePreview({
    manifestRef: ref,
    dependencies: world.dependencies,
  });

  assert.equal(site.entrypoint, "index.html");
  assert.equal(world.calls.length, 3);
  assert.equal(world.calls[0].address, PUBLIC_ADDRESS);
  assert.equal(world.calls[1].hostname, "other.example.com");
  assert.equal(world.calls[1].address, OTHER_ADDRESS);
  assert.equal(world.calls[2].url, entry.url);
});

test("rejects insecure, credentialed, and fragmented redirects", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);
  const cases = [
    [
      "https://cdn.example.com/start",
      "http://cdn.example.com/final",
      "url_insecure",
    ],
    [
      "https://cdn.example.com/start",
      "https://user:pass@cdn.example.com/final",
      "url_credentials",
    ],
    [
      "https://cdn.example.com/start",
      "https://cdn.example.com/final#frag",
      "url_invalid",
    ],
    [
      "https://cdn.example.com/start",
      "https://127.0.0.1/final",
      "url_blocked_host",
    ],
  ];
  for (const [url, location, code] of cases) {
    const world = createWorld({
      routes: new Map([[url, () => redirect(302, location)]]),
    });
    const ref = { url, sha256: sha256Hex(body) };
    await expectCode(
      loadWebsitePreview({
        manifestRef: ref,
        dependencies: world.dependencies,
      }),
      code,
    );
  }
});

test("enforces the redirect bound", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);
  const loop = "https://cdn.example.com/loop";
  const world = createWorld({
    routes: new Map([[loop, () => redirect(302, loop)]]),
  });
  const ref = { url: loop, sha256: sha256Hex(body) };

  await expectCode(
    loadWebsitePreview({
      manifestRef: ref,
      dependencies: world.dependencies,
      maxRedirects: 2,
    }),
    "redirect_limit",
  );
  assert.equal(world.calls.length, 3);
});

test("rejects a redirect without a location", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);
  const url = "https://cdn.example.com/start";
  const world = createWorld({
    routes: new Map([[url, () => reply({ status: 302 })]]),
  });

  await expectCode(
    loadWebsitePreview({
      manifestRef: { url, sha256: sha256Hex(body) },
      dependencies: world.dependencies,
    }),
    "http_status",
  );
});

test("rejects a redirect target whose DNS resolves private", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);
  const url = "https://cdn.example.com/start";
  const world = createWorld({
    addresses: {
      "cdn.example.com": [{ address: PUBLIC_ADDRESS, family: 4 }],
      "other.example.com": [{ address: "10.0.0.9", family: 4 }],
    },
    routes: new Map([
      [url, () => redirect(302, "https://other.example.com/final")],
    ]),
  });

  await expectCode(
    loadWebsitePreview({
      manifestRef: { url, sha256: sha256Hex(body) },
      dependencies: world.dependencies,
    }),
    "dns_blocked",
  );
});

test("rejects non-success responses and transport timeouts", async () => {
  const body = manifestBytes([fileEntry("index.html", "x")]);
  const missing = createWorld({
    routes: new Map([[MANIFEST_URL, () => reply({ status: 404 })]]),
  });
  await expectCode(
    loadWebsitePreview({
      manifestRef: { url: MANIFEST_URL, sha256: sha256Hex(body) },
      dependencies: missing.dependencies,
    }),
    "http_status",
  );

  const timeoutWorld = createWorld();
  timeoutWorld.dependencies.open = async () => {
    const error = new Error("socket stalled");
    error.code = "preview_timeout";
    throw error;
  };
  await expectCode(
    loadWebsitePreview({
      manifestRef: manifestRef(timeoutWorld, body),
      dependencies: timeoutWorld.dependencies,
    }),
    "timeout",
  );
});

test("refuses partial dependency injection", async () => {
  const manifestRefValue = {
    url: MANIFEST_URL,
    sha256: sha256Hex(bytes("x")),
  };
  await expectCode(
    loadWebsitePreview({
      manifestRef: manifestRefValue,
      dependencies: { lookup: async () => [] },
    }),
    "invalid_dependencies",
  );
  await expectCode(
    loadWebsitePreview({ manifestRef: manifestRefValue, dependencies: null }),
    "invalid_dependencies",
  );
});

test("validates artifact refs before any network work", async () => {
  const sha256 = sha256Hex(bytes("x"));
  await expectCode(
    () =>
      loadWebsitePreview({
        manifestRef: { url: MANIFEST_URL, sha256, extra: true },
        dependencies: {},
      }),
    "ref_invalid",
  );
  await expectCode(
    () =>
      loadWebsitePreview({ manifestRef: { url: MANIFEST_URL, sha256: "AB" } }),
    "sha256_invalid",
  );
  await expectCode(
    () =>
      loadWebsitePreview({
        manifestRef: { url: "http://cdn.example.com/m.json", sha256 },
      }),
    "url_insecure",
  );
});

test("rejects unknown fields and malformed shapes at every level", async () => {
  await expectCode(
    () => parsePreviewManifest(manifestBytes([], { extra: true })),
    "manifest_json",
  );
  const entry = { ...fileEntry("index.html", "x"), inline: true };
  await expectCode(
    () => parsePreviewManifest(manifestBytes([entry])),
    "manifest_json",
  );
  const missing = fileEntry("index.html", "x");
  delete missing.size;
  await expectCode(
    () => parsePreviewManifest(manifestBytes([missing])),
    "manifest_json",
  );
  await expectCode(() => parsePreviewManifest(bytes([])), "manifest_json");
  await expectCode(
    () => parsePreviewManifest(manifestBytes([42])),
    "manifest_json",
  );
});

test("rejects malformed manifest bytes", async () => {
  await expectCode(() => parsePreviewManifest(bytes("{")), "manifest_json");
  await expectCode(
    () => parsePreviewManifest(Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20)),
    "manifest_too_large",
  );
  await expectCode(() => parsePreviewManifest("not bytes"), "manifest_bytes");
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([], { schema: "colony.website-preview/2" }),
      ),
    "manifest_schema",
  );
});

test("rejects invalid asset paths", async () => {
  const cases = [
    ["", "empty"],
    ["/index.html", "leading slash"],
    ["index.html/", "trailing slash"],
    ["dir\\file.html", "backslash"],
    ["dir%2Ffile.html", "percent"],
    ["index.html?v=1", "query"],
    ["index.html#top", "fragment"],
    ["dir//file.html", "empty segment"],
    ["./index.html", "dot segment"],
    ["../index.html", "parent segment"],
    ["dir/../index.html", "inner parent"],
    ["dir/file.html.", "trailing dot segment"],
    ["dir/file.html ", "trailing space segment"],
    ["dir/\u0000file.html", "control character"],
    ["a".repeat(1025), "over 1024 bytes"],
  ];
  for (const [path, _reason] of cases) {
    await expectCode(
      () => parsePreviewManifest(manifestBytes([fileEntry(path, "x")])),
      "path_invalid",
    );
  }
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([fileEntry("index.html", "x")], {
          entrypoint: "../index",
        }),
      ),
    "path_invalid",
  );
});

test("rejects duplicate and case-folded paths", async () => {
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([
          fileEntry("index.html", "a"),
          fileEntry("index.html", "b"),
        ]),
      ),
    "path_duplicate",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([
          fileEntry("index.html", "a"),
          fileEntry("Index.html", "b"),
        ]),
      ),
    "path_ambiguous",
  );
});

test("requires a text/html entrypoint that exists", async () => {
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([fileEntry("main.js", "x", { mime: "text/javascript" })]),
      ),
    "entrypoint_missing",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([fileEntry("index.html", "x", { mime: "text/plain" })]),
      ),
    "entrypoint_not_html",
  );
});

test("enforces file, total, and count bounds", async () => {
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([
          fileEntry("index.html", "x", { mime: "application/pdf" }),
        ]),
      ),
    "mime_invalid",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([
          fileEntry("index.html", "x", { sha256: "A".repeat(64) }),
        ]),
      ),
    "sha256_invalid",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([fileEntry("index.html", "x", { size: 1.5 })]),
      ),
    "manifest_json",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([fileEntry("index.html", "x", { size: -1 })]),
      ),
    "manifest_json",
  );
  await expectCode(
    () =>
      parsePreviewManifest(
        manifestBytes([
          fileEntry("index.html", "x", { size: MAX_FILE_BYTES + 1 }),
        ]),
      ),
    "file_too_large",
  );

  const big = Array.from({ length: 5 }, (_, index) =>
    fileEntry(index === 0 ? "index.html" : `file-${index}.txt`, "x", {
      size: MAX_FILE_BYTES,
      mime: index === 0 ? "text/html" : "text/plain",
    }),
  );
  await expectCode(
    () => parsePreviewManifest(manifestBytes(big)),
    "total_too_large",
  );

  const many = Array.from({ length: 513 }, (_, index) =>
    fileEntry(`file-${index}.txt`, "x", { mime: "text/plain" }),
  );
  await expectCode(
    () => parsePreviewManifest(manifestBytes(many)),
    "too_many_files",
  );
});

test("rejects non-public and malformed file URLs", async () => {
  const cases = [
    ["http://cdn.example.com/a", "url_insecure"],
    ["https://user:pass@cdn.example.com/a", "url_credentials"],
    ["https://cdn.example.com/a#frag", "url_invalid"],
    ["https://127.0.0.1/a", "url_blocked_host"],
    ["https://[::1]/a", "url_blocked_host"],
    ["https://localhost/a", "url_blocked_host"],
    ["https://internal/a", "url_blocked_host"],
    ["https://foo.local/a", "url_blocked_host"],
    [`https://${"a".repeat(2050)}.example.com/x`, "url_invalid"],
    ["https://2130706433/a", "url_blocked_host"],
  ];
  for (const [url, code] of cases) {
    await expectCode(
      () =>
        parsePreviewManifest(
          manifestBytes([fileEntry("index.html", "x", { url })]),
        ),
      code,
    );
  }
});

test("classifies non-public addresses like the core", () => {
  const privateAddresses = [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "255.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "198.18.0.1",
    "198.19.255.254",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001::1",
    "2002::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::10.0.0.1",
    "::ffff:0:10.0.0.1",
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::1",
  ];
  const publicAddresses = [
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "2606:4700::1",
    "::8.8.8.8",
    "::ffff:8.8.8.8",
    "::ffff:0:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff",
    "64:ff9b::1:0:0",
    "fe00::1",
    "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:1::1",
    "2003::1",
    "0:0:0:0:fffe:ffff:ffff:ffff",
    "0:0:0:0:ffff:1:0:0",
  ];
  for (const address of privateAddresses) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of publicAddresses) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("pinned HTTPS options carry no credentials and pin the resolved address", () => {
  const options = buildHttpsRequestOptions({
    url: "https://cdn.example.com:8443/a/b?q=1",
    hostname: "cdn.example.com",
    address: PUBLIC_ADDRESS,
    family: 4,
  });
  assert.equal(options.host, PUBLIC_ADDRESS);
  assert.equal(options.servername, "cdn.example.com");
  assert.equal(options.port, 8443);
  assert.equal(options.path, "/a/b?q=1");
  assert.equal(options.headers.host, "cdn.example.com:8443");
  assert.equal(options.agent, false);
  const headerNames = Object.keys(options.headers).map((name) =>
    name.toLowerCase(),
  );
  assert.ok(
    !headerNames.some((name) => /cookie|authorization|proxy/.test(name)),
  );

  const literal = buildHttpsRequestOptions({
    url: "https://[2606:4700::1]/x",
    hostname: "2606:4700::1",
    address: "2606:4700::1",
    family: 6,
  });
  assert.equal(literal.servername, undefined);
  assert.equal(literal.headers.host, "[2606:4700::1]");
});

test("matches the shared core manifest vectors", () => {
  const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
  assert.equal(vectors.schema, "colony.website-test-vectors/1");
  assert.ok(vectors.cases.length >= 30);
  for (const vector of vectors.cases) {
    const raw = Buffer.from(JSON.stringify(vector.manifest), "utf8");
    let code = "ok";
    try {
      parsePreviewManifest(raw);
    } catch (error) {
      code = error?.code;
    }
    assert.equal(code, vector.expect, vector.name);
  }
});
