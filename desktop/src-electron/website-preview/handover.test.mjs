import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { createWebsiteHandover } from "./handover.mjs";

const bytes = Buffer.from("<h1>Reviewed website</h1>");
const file = { path: "index.html", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") };
const site = { files: [file], entrypoint: "index.html",
  manifestSha256: "a".repeat(64), getFile: () => ({ ...file, bytes }) };
const identity = { artifactId: "b".repeat(64), revision: 2 };
test("handover contains exact bytes and pinned version without publication authority", async () => {
  const entries = unzipSync(await createWebsiteHandover(site, identity));
  assert.deepEqual(Buffer.from(entries["website/index.html"]), bytes);
  const metadata = JSON.parse(Buffer.from(entries["colony-handover.json"]).toString());
  assert.equal(metadata.artifactId, identity.artifactId);
  assert.equal(metadata.revision, 2);
  assert.equal(metadata.manifestSha256, site.manifestSha256);
  assert.match(metadata.description, /does not publish/);
});
test("handover refuses changed bytes, duplicates and unsafe paths", async () => {
  await assert.rejects(createWebsiteHandover({ ...site,
    getFile: () => ({ ...file, bytes: Buffer.alloc(bytes.length) }) }, identity));
  await assert.rejects(createWebsiteHandover({ ...site, files: [file, file] }, identity));
  await assert.rejects(createWebsiteHandover({ ...site,
    files: [{ ...file, path: "../escape.html" }] }, identity));
});

test("handover includes exact pinned source archive and rejects altered source", async () => {
  const source = Buffer.from("opaque source archive");
  const fullSite = { ...site, sourceArchive: { size: source.length,
    sha256: createHash("sha256").update(source).digest("hex") }, getSourceArchive: () => Buffer.from(source) };
  const entries = unzipSync(await createWebsiteHandover(fullSite, identity));
  assert.deepEqual(Buffer.from(entries["source/project.zip"]), source);
  const metadata = JSON.parse(Buffer.from(entries["colony-handover.json"]).toString());
  assert.equal(metadata.sourceArchive.sha256, fullSite.sourceArchive.sha256);
  await assert.rejects(createWebsiteHandover({ ...fullSite, getSourceArchive: () => Buffer.alloc(source.length) }, identity));
});

test("handover preserves signed approval provenance and rejects another version", async () => {
  const event = finalizeEvent({ kind: 40010, created_at: 1789500000,
    content: JSON.stringify({ scope: "design-only", revision: identity.revision, manifest_sha256: site.manifestSha256 }),
    tags: [["e", identity.artifactId, "", "block-instance"],
      ["block-action", "1", "artifact.approve-design", "instance", "request"]],
  }, new Uint8Array(32).fill(1));
  const entries = unzipSync(await createWebsiteHandover(site, identity, event));
  const saved = JSON.parse(Buffer.from(entries["design-approval.json"]).toString());
  assert.equal(verifyEvent(saved), true);
  assert.deepEqual(saved, JSON.parse(JSON.stringify(event)));
  await assert.rejects(createWebsiteHandover(site, { ...identity, revision: 3 }, event));
  await assert.rejects(createWebsiteHandover(site, identity, { ...event, content: "{}" }));
});
