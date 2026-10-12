import assert from "node:assert/strict";
import { test } from "node:test";
import { MOVE_SECONDS } from "./camera.ts";
import { checkManifest } from "./manifest.ts";
import { START_HERE } from "./startHereBeats.ts";
import { fixtureManifest } from "./testManifest.ts";
import { timeline } from "./timeline.ts";
import {
  CLICK_AFTER,
  clicksOf,
  placeMoves,
  pointerKeys,
  SHOT_FADE,
  shotAt,
} from "./userTimeline.ts";
import { voiceSeconds } from "./voiceCuts.ts";

const tl = timeline(START_HERE, voiceSeconds);
const placed = placeMoves(START_HERE, tl);

test("moves land inside their beats, in order", () => {
  let last = -1;
  for (const p of placed) {
    const beat = tl.beats.find((b) => b.id === p.beat);
    assert.ok(beat && p.at >= beat.from && p.at < beat.to, p.beat);
    assert.ok(p.at > last, `${p.beat} goes back in time`);
    last = p.at;
  }
});

test("every click comes after the camera settles and before the next move", () => {
  for (const [i, p] of placed.entries()) {
    if (!p.move.click) continue;
    const click = p.at + CLICK_AFTER;
    assert.ok(
      CLICK_AFTER >= MOVE_SECONDS,
      "click lands while the camera moves",
    );
    const next = placed[i + 1];
    assert.ok(
      !next || click + 0.2 <= next.at,
      `${p.beat}: ${p.move.click} is cut off`,
    );
  }
});

test("the pointer is on each click's target when it clicks", () => {
  const manifest = checkManifest(fixtureManifest());
  const clicks = clicksOf(placed);
  const keys = pointerKeys(clicks, manifest);
  for (const click of clicks) {
    const key = keys.find((k) => Math.abs(k.at - (click.at - 0.08)) < 1e-9);
    assert.ok(key, `${click.target}: no key before its click`);
  }
});

test("a new shot fades in over the old one, then holds", () => {
  const change = placed.find(
    (p, i) => i > 0 && p.move.shot !== placed[i - 1].move.shot,
  );
  assert.ok(change);
  const before = shotAt(placed, change.at - 0.01);
  const during = shotAt(placed, change.at + SHOT_FADE / 2);
  const after = shotAt(placed, change.at + SHOT_FADE + 0.01);
  assert.notEqual(before.shot, change.move.shot);
  assert.equal(during.shot, change.move.shot);
  assert.ok(during.mix > 0 && during.mix < 1 && during.previous);
  assert.equal(after.mix, 1);
});
