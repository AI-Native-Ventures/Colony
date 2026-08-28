// Source scan, not a behaviour test: `completeFirstRunIo` imports Tauri
// modules, so it cannot be loaded under `node --test`. The behaviour it guards
// is covered twice elsewhere — `events/tests.rs` pins the native validator, and
// the e2e mock bridge throws when a `client` tag arrives on the Blocks channel.
// What this file catches is the specific regression that broke first-run
// completion on 2026-08-27: the marker being handed to `blockReferenceTags`,
// which looks correct at the call site and only fails inside Rust.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("./completeFirstRunIo.ts", import.meta.url)),
  "utf8",
);

test("first task marker travels on the client tag channel", () => {
  assert.match(source, /clientTags: \[\["client", marker\]\]/);
});

test("first task marker never travels on the block reference channel", () => {
  const blockChannel = source.match(/blockReferenceTags:[^\n]*/g) ?? [];
  assert.deepEqual(
    blockChannel,
    [],
    `completeFirstRunIo must not send Block reference tags, found: ${blockChannel.join(", ")}`,
  );
});
