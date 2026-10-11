import assert from "node:assert/strict";
import { test } from "node:test";
import { legAngles } from "./gait.ts";

test("the two leg tripods swing opposite each other", () => {
  for (const p of [0, 0.1, 0.25, 0.4, 0.5, 0.77]) {
    const { a, b } = legAngles(p);
    assert.ok(Math.abs(a + b + 5) < 1e-9, `tripods not opposite at ${p}`);
  }
  assert.equal(legAngles(0).a, 0);
  assert.equal(legAngles(0.5).b, 0);
});

test("legs stay inside the brand gait's 0 to -5 degrees", () => {
  for (let p = 0; p <= 1; p += 0.01) {
    const { a, b } = legAngles(p);
    assert.ok(a <= 0 && a >= -5 && b <= 0 && b >= -5);
  }
});

test("the gait repeats every cycle", () => {
  assert.deepEqual(legAngles(0.3), legAngles(1.3));
  assert.deepEqual(legAngles(0.3), legAngles(-0.7));
});

test("the body bobs up at the quarter steps and rests at the half steps", () => {
  assert.ok(Math.abs(legAngles(0.25).bob + 0.01) < 1e-9);
  assert.ok(Math.abs(legAngles(0.5).bob) < 1e-9);
});
