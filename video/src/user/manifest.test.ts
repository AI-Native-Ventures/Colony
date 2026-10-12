import assert from "node:assert/strict";
import { test } from "node:test";
import { type Box, checkManifest, SHOT_IDS, unionBox } from "./manifest.ts";
import { fixtureManifest } from "./testManifest.ts";

test("a manifest with every shot and box passes", () => {
  const manifest = checkManifest(fixtureManifest());
  assert.equal(Object.keys(manifest.shots).length, SHOT_IDS.length);
});

test("a missing shot is named", () => {
  const raw = fixtureManifest();
  delete (raw.shots as Record<string, unknown>)["business-read"];
  assert.throws(() => checkManifest(raw), /business-read: missing/);
});

test("a missing box is named with its shot", () => {
  const raw = fixtureManifest();
  delete (raw.shots["business-read"] as { boxes: Record<string, Box> }).boxes
    .summary;
  assert.throws(() => checkManifest(raw), /business-read: no box "summary"/);
});

test("a shot at another size than the app window is refused", () => {
  const raw = fixtureManifest();
  (raw.shots.account as { width: number }).width = 1280;
  assert.throws(() => checkManifest(raw), /account: 1280 x 900/);
});

test("boxes join into the smallest box around them", () => {
  assert.deepEqual(
    unionBox([
      { x: 10, y: 20, w: 30, h: 10 },
      { x: 25, y: 5, w: 10, h: 10 },
    ]),
    { x: 10, y: 5, w: 30, h: 25 },
  );
});
