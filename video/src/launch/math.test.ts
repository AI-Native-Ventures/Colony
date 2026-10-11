import assert from "node:assert/strict";
import { test } from "node:test";
import {
  easeInOutCubic,
  easeOutExpo,
  hslToRgb,
  lerpAngle,
  mulberry32,
  progress,
  smoothstep,
} from "./math.ts";

test("mulberry32 repeats exactly for the same seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.notDeepEqual(seqA, [mulberry32(43)(), 0, 0, 0]);
});

test("easings hit their ends and clamp outside 0..1", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(-3), 0);
  assert.equal(easeInOutCubic(7), 1);
  assert.equal(easeOutExpo(0), 0);
  assert.equal(easeOutExpo(1), 1);
});

test("progress and smoothstep clamp", () => {
  assert.equal(progress(0, 1, 2), 0);
  assert.equal(progress(2, 1, 2), 0.5);
  assert.equal(progress(9, 1, 2), 1);
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(0, 1, 2), 1);
});

test("lerpAngle goes the short way round", () => {
  const mid = lerpAngle(3.0, -3.0, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-9, `got ${mid}`);
});

test("hslToRgb matches the brand hues", () => {
  assert.deepEqual(hslToRgb(258, 90, 66), [137, 90, 246]);
  assert.deepEqual(hslToRgb(217, 91, 60), [60, 131, 246]);
  assert.deepEqual(hslToRgb(330, 81, 60), [236, 70, 153]);
  assert.deepEqual(hslToRgb(38, 92, 50), [245, 159, 10]);
  assert.deepEqual(hslToRgb(160, 60, 45), [46, 184, 138]);
});
