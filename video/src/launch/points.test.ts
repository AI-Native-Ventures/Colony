import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "./math.ts";
import { fitFontSize, pickPoints, sampleAlphaPoints } from "./points.ts";

function block(
  width: number,
  height: number,
  alpha: number,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 3; y <= 5; y++)
    for (let x = 2; x <= 4; x++) rgba[(y * width + x) * 4 + 3] = alpha;
  return rgba;
}

test("samples only opaque cells on the grid", () => {
  assert.equal(sampleAlphaPoints(block(10, 10, 255), 10, 10, 1).length, 9);
  assert.deepEqual(sampleAlphaPoints(block(10, 10, 255), 10, 10, 2), [
    { x: 3, y: 3 },
    { x: 3, y: 5 },
  ]);
});

test("respects the alpha threshold", () => {
  assert.equal(sampleAlphaPoints(block(10, 10, 100), 10, 10, 1).length, 0);
  assert.equal(sampleAlphaPoints(block(10, 10, 100), 10, 10, 1, 90).length, 9);
});

test("pickPoints returns exactly n, deterministically, cycling a small pool", () => {
  const pool = [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 3 },
  ];
  const a = pickPoints(pool, 7, mulberry32(5));
  const b = pickPoints(pool, 7, mulberry32(5));
  assert.equal(a.length, 7);
  assert.deepEqual(a, b);
  for (const p of a) assert.ok(pool.includes(p));
});

test("pickPoints refuses an empty pool", () => {
  assert.throws(() => pickPoints([], 3, mulberry32(1)), /empty pool/);
});

test("fitFontSize shrinks long lines and leaves short ones alone", () => {
  const measure = (size: number) => size * 5;
  assert.equal(fitFontSize(measure, 100, 400), 80);
  assert.equal(fitFontSize(measure, 100, 600), 100);
});
