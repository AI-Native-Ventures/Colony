import assert from "node:assert/strict";
import test from "node:test";

import {
  borderBackground,
  hasTransparency,
  removeBackground,
  silhouette,
} from "./logoVariants.ts";

/** Build a w*h RGBA image filled with one colour. */
function solid(width, height, [r, g, b, a]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

function setPixel(data, width, x, y, [r, g, b, a]) {
  const offset = (y * width + x) * 4;
  data[offset] = r;
  data[offset + 1] = g;
  data[offset + 2] = b;
  data[offset + 3] = a;
}

function alphaAt(data, width, x, y) {
  return data[(y * width + x) * 4 + 3];
}

const WHITE = [255, 255, 255, 255];
const RED = [200, 30, 40, 255];
const CLEAR = [0, 0, 0, 0];

test("an opaque image has no transparency", () => {
  assert.equal(hasTransparency(solid(8, 8, WHITE)), false);
});

test("a few stray transparent pixels do not count as transparency", () => {
  const data = solid(10, 10, WHITE);
  setPixel(data, 10, 0, 0, CLEAR);
  assert.equal(hasTransparency(data), false);
});

test("a meaningfully transparent image is recognised", () => {
  const data = solid(10, 10, WHITE);
  for (let x = 0; x < 10; x += 1) {
    setPixel(data, 10, x, 0, CLEAR);
  }
  assert.equal(hasTransparency(data), true);
});

test("a uniform border resolves to its colour", () => {
  const data = solid(12, 12, WHITE);
  // A red block in the middle must not disturb the border reading.
  for (let y = 3; y < 9; y += 1) {
    for (let x = 3; x < 9; x += 1) {
      setPixel(data, 12, x, y, RED);
    }
  }
  assert.deepEqual(borderBackground(data, 12, 12), [255, 255, 255]);
});

test("a two-colour border refuses to name a background", () => {
  const data = solid(12, 12, WHITE);
  for (let x = 0; x < 12; x += 1) {
    setPixel(data, 12, x, 0, RED);
    setPixel(data, 12, x, 1, RED);
  }
  assert.equal(borderBackground(data, 12, 12), null);
});

test("background removal lifts the border colour but keeps enclosed counters", () => {
  const size = 16;
  const data = solid(size, size, WHITE);
  // A red ring: rows/cols 4..11, with a white counter hole inside it that is
  // NOT connected to the border.
  for (let y = 4; y < 12; y += 1) {
    for (let x = 4; x < 12; x += 1) {
      setPixel(data, size, x, y, RED);
    }
  }
  for (let y = 7; y < 9; y += 1) {
    for (let x = 7; x < 9; x += 1) {
      setPixel(data, size, x, y, WHITE);
    }
  }
  const out = removeBackground(data, size, size, [255, 255, 255]);
  // The outer white is gone.
  assert.equal(alphaAt(out, size, 0, 0), 0);
  assert.equal(alphaAt(out, size, 15, 15), 0);
  assert.equal(alphaAt(out, size, 2, 8), 0);
  // The logo body stays.
  assert.equal(alphaAt(out, size, 5, 5), 255);
  // The counter inside the letterform stays white and opaque.
  assert.equal(alphaAt(out, size, 7, 7), 255);
  // The input was not mutated.
  assert.equal(alphaAt(data, size, 0, 0), 255);
});

test("silhouette recolours visible pixels and keeps alpha", () => {
  const data = solid(4, 4, RED);
  setPixel(data, 4, 0, 0, CLEAR);
  const out = silhouette(data, [255, 255, 255]);
  assert.equal(alphaAt(out, 4, 0, 0), 0);
  const offset = (1 * 4 + 1) * 4;
  assert.deepEqual(
    [out[offset], out[offset + 1], out[offset + 2], out[offset + 3]],
    [255, 255, 255, 255],
  );
  // The input was not mutated.
  assert.equal(data[(1 * 4 + 1) * 4], 200);
});
