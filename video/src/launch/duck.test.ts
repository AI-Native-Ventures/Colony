import assert from "node:assert/strict";
import { test } from "node:test";
import { musicVolume } from "./duck.ts";

const windows: Array<readonly [number, number]> = [
  [2, 4],
  [10, 12],
];
const opts = { base: 0.6, ducked: 0.25, attack: 0.25, release: 0.4 };

test("music plays at full level far from any voice line", () => {
  assert.equal(musicVolume(0, windows, opts), 0.6);
  assert.equal(musicVolume(7, windows, opts), 0.6);
});

test("music sits low in the middle of a voice line", () => {
  assert.equal(musicVolume(3, windows, opts), 0.25);
  assert.equal(musicVolume(11, windows, opts), 0.25);
});

test("music is already low when the first word starts", () => {
  assert.equal(musicVolume(2, windows, opts), 0.25);
});

test("music recovers within the release time after a line ends", () => {
  assert.equal(musicVolume(4 + 0.4, windows, opts), 0.6);
});

test("music never jumps between frames at 30 fps", () => {
  let prev = musicVolume(0, windows, opts);
  for (let f = 1; f <= 30 * 14; f++) {
    const next = musicVolume(f / 30, windows, opts);
    assert.ok(Math.abs(next - prev) <= 0.08, `jump at frame ${f}`);
    prev = next;
  }
});
