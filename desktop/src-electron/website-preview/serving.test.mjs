import assert from "node:assert/strict";
import { test } from "node:test";
import { servePreviewRequest, isAllowedEntryUrl } from "./serving.mjs";
import { normalizePreviewPath, PREVIEW_WRAPPER_PATH } from "./scheme.mjs";

function fixture() {
  const files = new Map([
    ["index.html", { mime: "text/html", bytes: Buffer.from('<link rel="stylesheet" href="site.css"><img src="logo.svg"><script>window.page="home"</script>') }],
    ["about.html", { mime: "text/html", bytes: Buffer.from('<script>window.page="about"</script>') }],
    ["site.css", { mime: "text/css", bytes: Buffer.from("body{background:purple}") }],
    ["logo.svg", { mime: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }],
  ]);
  return {
    disposed: false, token: "artifact", wrapperToken: "wrapper",
    pixelWidth: 1280, pixelHeight: 900,
    paths: new Set(files.keys()),
    site: { entrypoint: "index.html", getFile: (path) => files.get(path) ?? null },
  };
}
const request = (path, token = "artifact") => ({ url: `colony-preview://${token}/${path}`, method: "GET" });

test("serves listed HTML, images and styles with restrictive headers", async () => {
  const entry = fixture();
  for (const path of entry.paths) {
    const response = servePreviewRequest(entry, request(path));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), entry.site.getFile(path).bytes);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(response.headers.get("content-security-policy"), /form-action 'none'/);
  }
});

test("each page authorizes its own inline script bytes", () => {
  const entry = fixture();
  const home = servePreviewRequest(entry, request("index.html")).headers.get("content-security-policy");
  const about = servePreviewRequest(entry, request("about.html")).headers.get("content-security-policy");
  assert.match(home, /'sha256-/);
  assert.notEqual(home, about);
  assert.doesNotMatch(home.split(";")[1], /'unsafe-inline'/);
  assert.match(home, /frame-ancestors colony-preview:\/\/wrapper/);
});

test("unknown paths, foreign tokens, writes and disposed previews fail closed", () => {
  const entry = fixture();
  for (const req of [request("missing.html"), request("index.html", "other"), { url: "https://example.com/index.html" }]) {
    assert.equal(servePreviewRequest(entry, req).status, 404);
  }
  assert.equal(servePreviewRequest(entry, { ...request("index.html"), method: "POST" }).status, 405);
  entry.disposed = true;
  assert.equal(servePreviewRequest(entry, request("index.html")).status, 404);
});

test("wrapper and artifact cannot navigate into each other's frame", async () => {
  const entry = fixture();
  const wrapper = request(PREVIEW_WRAPPER_PATH, "wrapper");
  assert.equal(isAllowedEntryUrl(entry, wrapper.url), true);
  assert.equal(isAllowedEntryUrl(entry, request("index.html").url), false);
  assert.equal(isAllowedEntryUrl(entry, wrapper.url, { isMainFrame: false }), false);
  assert.equal(isAllowedEntryUrl(entry, request("about.html").url, { isMainFrame: false }), true);
  const response = servePreviewRequest(entry, wrapper);
  assert.match(await response.text(), /sandbox="allow-scripts allow-same-origin"/);
  assert.match(response.headers.get("content-security-policy"), /frame-src colony-preview:\/\/artifact/);
});

test("encoded separators and traversal never resolve to asset keys", () => {
  for (const path of ["/a%2fb", "/a%5cb", "/../index.html", "/a/./b", "/%252e/index.html", "/a\\b"]) {
    assert.equal(normalizePreviewPath(path), null, path);
  }
  assert.equal(normalizePreviewPath("/images/logo.svg"), "images/logo.svg");
});
