import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./splitterMath.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

test("resizePair shifts fraction between left/right siblings", async () => {
  const m = await load();
  const start = [0.4, 0.6];
  const next = m.resizePair(start, 1, 0.1);
  assert.ok(Math.abs(next[0] - 0.5) < 0.01);
  assert.ok(Math.abs(next[1] - 0.5) < 0.01);
});

test("resizePair clamps at MIN_SPLIT_SIZE and preserves pair total", async () => {
  const m = await load();
  const start = [0.5, 0.5];
  const next = m.resizePair(start, 1, -0.5);
  assert.equal(Math.round(next[0] * 10) / 10, 0.2);
  assert.equal(Math.round(next[1] * 10) / 10, 0.8);
  assert.equal(Math.abs(next[0] + next[1] - 1.0), 0);
});

test("resizePair leaves other siblings untouched", async () => {
  const m = await load();
  const start = [0.3, 0.3, 0.4];
  const next = m.resizePair(start, 2, 0.1);
  assert.ok(Math.abs(next[0] - 0.3) < 0.01);
  assert.ok(Math.abs(next[1] - 0.4) < 0.01);
  assert.ok(Math.abs(next[2] - 0.3) < 0.01);
});

test("resizePair ignores out-of-range split index", async () => {
  const m = await load();
  const start = [0.4, 0.6];
  assert.deepEqual(m.resizePair(start, 0, 0.1), start);
  assert.deepEqual(m.resizePair(start, 5, 0.1), start);
});
