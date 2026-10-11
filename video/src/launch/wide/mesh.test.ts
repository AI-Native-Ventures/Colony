import assert from "node:assert/strict";
import { test } from "node:test";
import { LIGHT_WORLD, PALETTES, paletteWeights } from "./mesh.ts";

test("palette weights always add up to one, at most two at a time", () => {
  for (let t = -1; t <= 120; t += 0.05) {
    const w = paletteWeights(t, LIGHT_WORLD);
    assert.ok(w.length >= 1 && w.length <= 2, `${w.length} palettes at ${t}`);
    const sum = w.reduce((a, b) => a + b.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum to ${sum} at ${t}`);
  }
});

test("each stop's palette is fully in once its crossfade is over", () => {
  for (const stop of LIGHT_WORLD) {
    const w = paletteWeights(stop.at + 0.7, LIGHT_WORLD);
    assert.equal(w.length, 1);
    assert.equal(w[0].id, stop.id);
  }
});

test("the film opens on the first palette with nothing blending in", () => {
  const w = paletteWeights(0, LIGHT_WORLD);
  assert.deepEqual(w, [{ id: LIGHT_WORLD[0].id, weight: 1 }]);
});

test("every palette is soft: a light base and a few blobs", () => {
  for (const [id, p] of Object.entries(PALETTES)) {
    assert.ok(p.blobs.length >= 3 && p.blobs.length <= 6, id);
    const hex = p.base.replace("#", "");
    const lum =
      (0.2126 * parseInt(hex.slice(0, 2), 16) +
        0.7152 * parseInt(hex.slice(2, 4), 16) +
        0.0722 * parseInt(hex.slice(4, 6), 16)) /
      255;
    assert.ok(lum > 0.6, `${id} base is too dark (${lum.toFixed(2)})`);
  }
});
