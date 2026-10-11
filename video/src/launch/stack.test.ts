import assert from "node:assert/strict";
import { test } from "node:test";
import { stackY } from "./stack.ts";

const sizes = [140, 120, 160];
const ats = [0.1, 0.4, 0.7];
const opts = { centerY: 960, leading: 0.94, pushSeconds: 0.3 };

test("a lone landed word sits on the centre line", () => {
  const ys = stackY(sizes, ats, 0.25, opts);
  assert.equal(ys[0], 960);
});

test("once every word has landed the tower is centred", () => {
  const ys = stackY(sizes, ats, 5, opts);
  assert.ok(Math.abs((ys[0] + ys[2]) / 2 - 960) < 1e-9);
});

test("words keep their order top to bottom with tight leading", () => {
  const ys = stackY(sizes, ats, 5, opts);
  assert.ok(Math.abs(ys[1] - ys[0] - ((140 + 120) / 2) * 0.94) < 1e-9);
  assert.ok(Math.abs(ys[2] - ys[1] - ((120 + 160) / 2) * 0.94) < 1e-9);
});

test("a landing word pushes the tower smoothly, never in a jump", () => {
  let prev = stackY(sizes, ats, 0.35, opts);
  for (let t = 0.35; t < 1.2; t += 1 / 240) {
    const next = stackY(sizes, ats, t, opts);
    for (let i = 0; i < sizes.length; i++) {
      assert.ok(Math.abs(next[i] - prev[i]) < 6, `jump for word ${i} at ${t}`);
    }
    prev = next;
  }
});
