import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePreviewManifest, PREVIEW_SCHEMA } from "./manifest.mjs";

const file = (path, mime = "text/html") => ({
  path, mime, url: "https://example.com/asset", sha256: "a".repeat(64), size: 10,
});
const parse = (files, entrypoint = "index.html") => parsePreviewManifest(
  Buffer.from(JSON.stringify({ schema: PREVIEW_SCHEMA, entrypoint, files })),
);
test("accepts a bounded site with local HTML CSS image and script assets", () => {
  const result = parse([file("index.html"), file("about.html"), file("style.css", "text/css"), file("hero.png", "image/png"), file("app.js", "text/javascript")]);
  assert.equal(result.files.length, 5);
  assert.ok(Object.isFrozen(result.files));
});
test("rejects traversal, ambiguous paths, missing entrypoint and oversized assets", () => {
  for (const files of [
    [file("../index.html")], [file("index.html"), file("INDEX.html")],
    [file("other.html")], [{ ...file("index.html"), size: 100_000_000 }],
  ]) assert.throws(() => parse(files));
});
test("rejects private source addresses and malformed digests", () => {
  for (const patch of [
    { url: "https://127.0.0.1/site" }, { url: "https://[::1]/site" },
    { url: "http://example.com/site" }, { sha256: "not-a-digest" },
  ]) assert.throws(() => parse([{ ...file("index.html"), ...patch }]));
});

test("source archive retains URL and byte limits", () => {
  const source = { url: "https://example.com/source.zip", sha256: "b".repeat(64), size: 50 };
  const withSource = (patch) => parsePreviewManifest(Buffer.from(JSON.stringify({
    schema: PREVIEW_SCHEMA, entrypoint: "index.html", files: [file("index.html")], source_archive: { ...source, ...patch },
  })));
  assert.equal(withSource({}).sourceArchive.sha256, source.sha256);
  for (const patch of [{ size: 0 }, { size: 100_000_000 }, { url: "https://127.0.0.1/source.zip" }, { sha256: "bad" }]) {
    assert.throws(() => withSource(patch));
  }
});
