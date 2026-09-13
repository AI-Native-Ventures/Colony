import assert from "node:assert/strict";
import { test } from "node:test";

import { loadWebsitePreview, PREVIEW_SCHEMA, sha256Hex } from "./artifact.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";
const MANIFEST_URL = "https://cdn.example.com/site/manifest.json";

function bytes(value) {
  return Buffer.from(value, "utf8");
}

function reply(chunks) {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html" },
    destroy() {},
    body: (async function* () {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })(),
  };
}

function fileEntry(path, content, options = {}) {
  const contentBytes = Buffer.isBuffer(content)
    ? content
    : bytes(content ?? path);
  return {
    path,
    url: options.url ?? `https://cdn.example.com/assets/${path}`,
    sha256: options.sha256 ?? sha256Hex(contentBytes),
    mime: options.mime ?? (path.endsWith(".html") ? "text/html" : "text/plain"),
    size: options.size ?? contentBytes.byteLength,
  };
}

function createDependencies(routes) {
  return {
    async lookup() {
      return [{ address: PUBLIC_ADDRESS, family: 4 }];
    },
    async open(request) {
      const handler = routes.get(request.url);
      if (handler === undefined) {
        throw Object.assign(new Error(`no route for ${request.url}`), {
          code: "ENOTFOUND",
        });
      }
      return handler(request);
    },
  };
}

async function loadSite(files, contents) {
  const routes = new Map();
  const manifest = bytes(
    JSON.stringify({
      schema: PREVIEW_SCHEMA,
      entrypoint: "index.html",
      files,
    }),
  );
  routes.set(MANIFEST_URL, () => reply([manifest]));
  for (let index = 0; index < files.length; index += 1) {
    const content = contents[index];
    routes.set(files[index].url, () => reply([content]));
  }
  return loadWebsitePreview({
    manifestRef: { url: MANIFEST_URL, sha256: sha256Hex(manifest) },
    dependencies: createDependencies(routes),
  });
}

test("files and entrypointFile expose frozen metadata with no bytes", async () => {
  const html = bytes("<!doctype html><title>hi</title>");
  const css = bytes("body { color: red }");
  const site = await loadSite(
    [
      fileEntry("index.html", html),
      fileEntry("assets/app.css", css, { mime: "text/css" }),
    ],
    [html, css],
  );

  assert.ok(Object.isFrozen(site));
  assert.ok(Object.isFrozen(site.files));
  assert.equal(site.files.length, 2);
  for (const record of site.files) {
    assert.ok(Object.isFrozen(record));
    assert.equal("bytes" in record, false);
    assert.deepEqual(Object.keys(record).sort(), [
      "contentType",
      "mime",
      "path",
      "sha256",
      "size",
      "url",
    ]);
  }

  assert.ok(Object.isFrozen(site.entrypointFile));
  assert.equal(site.entrypointFile.path, "index.html");
  assert.equal("bytes" in site.entrypointFile, false);
  assert.equal(site.store, undefined);
  assert.equal(site.byPath, undefined);
});

test("getFile returns a fresh, mutable copy on every call", async () => {
  const html = bytes("entry bytes stay stable");
  const site = await loadSite([fileEntry("index.html", html)], [html]);

  const first = site.getFile("index.html");
  assert.ok(Object.isFrozen(first));
  assert.ok(Buffer.isBuffer(first.bytes));
  assert.equal(Object.isFrozen(first.bytes), false);
  assert.deepEqual(first.bytes, html);

  first.bytes.fill(0);
  assert.throws(() => {
    first.path = "mutated.html";
  }, TypeError);

  const second = site.getFile("index.html");
  assert.deepEqual(second.bytes, html);
  assert.equal(second.path, "index.html");
  assert.notEqual(second.bytes, first.bytes);
  assert.equal(site.getFile("mutated.html"), null);
});

test("records and arrays reject mutation without changing stored bytes", async () => {
  const html = bytes("original");
  const site = await loadSite([fileEntry("index.html", html)], [html]);

  assert.throws(() => {
    site.files[0].path = "other.html";
  }, TypeError);
  assert.throws(() => {
    site.files.push(site.files[0]);
  }, TypeError);
  assert.throws(() => {
    site.entrypointFile.bytes = Buffer.from("forged");
  }, TypeError);
  assert.deepEqual(site.getFile("index.html").bytes, html);
  assert.equal(site.getFile("other.html"), null);
});

test("mutating a served entrypoint copy cannot alter later reads", async () => {
  const html = bytes("stable");
  const site = await loadSite([fileEntry("index.html", html)], [html]);

  const served = site.getFile(site.entrypoint);
  served.bytes.write("evil");
  assert.deepEqual(site.getFile(site.entrypoint).bytes, html);
  assert.deepEqual(site.getFile("index.html").bytes, html);
});

test("getFile returns null for unknown and non-string paths", async () => {
  const html = bytes("x");
  const site = await loadSite([fileEntry("index.html", html)], [html]);

  assert.equal(site.getFile("missing.html"), null);
  assert.equal(site.getFile(42), null);
  assert.equal(site.getFile(undefined), null);
});

test("a failed verification returns no artifact and exposes no bytes", async () => {
  const html = bytes("real bytes");
  const entry = fileEntry("index.html", html, {
    sha256: sha256Hex(bytes("other")),
  });
  const manifest = bytes(
    JSON.stringify({
      schema: PREVIEW_SCHEMA,
      entrypoint: "index.html",
      files: [entry],
    }),
  );
  const routes = new Map();
  routes.set(MANIFEST_URL, () => reply([manifest]));
  routes.set(entry.url, () => reply([html]));

  await assert.rejects(
    loadWebsitePreview({
      manifestRef: { url: MANIFEST_URL, sha256: sha256Hex(manifest) },
      dependencies: createDependencies(routes),
    }),
    (error) => error?.code === "digest_mismatch",
  );
});
