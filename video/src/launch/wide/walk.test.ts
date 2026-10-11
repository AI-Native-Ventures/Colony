import assert from "node:assert/strict";
import { test } from "node:test";
import { type Path, walkState } from "./walk.ts";

const path: Path = [
  { x: 100, y: 900 },
  { x: 300, y: 700 },
  { x: 600, y: 500 },
  { x: 800, y: 400 },
];

test("an ant waits at the start of its path, legs still", () => {
  const s = walkState(path, 1, 2, 1.5);
  assert.equal(s.x, 100);
  assert.equal(s.y, 900);
  assert.equal(s.amp, 0);
});

test("an ant ends exactly at the end of its path, legs still", () => {
  const s = walkState(path, 9, 2, 1.5);
  assert.ok(Math.abs(s.x - 800) < 1e-9 && Math.abs(s.y - 400) < 1e-9);
  assert.equal(s.amp, 0);
});

test("legs move while the ant is walking", () => {
  assert.equal(walkState(path, 2.75, 2, 1.5).amp, 1);
});

test("walking never jumps between frames", () => {
  let prev = walkState(path, 1.9, 2, 1.5);
  for (let t = 1.9; t < 3.7; t += 1 / 60) {
    const next = walkState(path, t, 2, 1.5);
    assert.ok(
      Math.hypot(next.x - prev.x, next.y - prev.y) < 25,
      `jump at ${t}`,
    );
    prev = next;
  }
});

test("the gait phase grows with the distance walked", () => {
  const early = walkState(path, 2.3, 2, 1.5).phase;
  const late = walkState(path, 3.2, 2, 1.5).phase;
  assert.ok(late > early);
});
