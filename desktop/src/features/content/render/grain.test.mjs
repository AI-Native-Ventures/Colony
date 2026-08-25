// The grain gate's pixel maths, tested without a browser.
//
// The figures matter because "too solid" was a real review note on the launch
// build, and the gate's job is to make that note a number. So the tests are
// built from frames whose graininess is known by construction: a flat field
// has none, a gradient is low-frequency and must score near zero despite
// varying a lot, and salt-and-pepper noise is high-frequency and must score
// high despite varying no more overall.

import assert from "node:assert/strict";
import test from "node:test";

import {
  flattestTile,
  grainWithin,
  luminancePlane,
  measureGrain,
} from "./grain.ts";

const W = 64;
const H = 64;

/** A frame painted by a function of (x, y) returning a 0-255 grey. */
function frame(paint, width = W, height = H) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = paint(x, y);
      const i = (y * width + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Deterministic pseudo-noise, so a failure is reproducible. */
function noise(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

test("luminance is float64, not float32", () => {
  // The upstream tool used a Float32Array here. It got away with it because it
  // only compared these values to each other; anything comparing one against a
  // threshold computed in ordinary JS arithmetic can be wrong by 1 ulp.
  const plane = luminancePlane(
    frame(() => 128),
    W,
    H,
  );
  assert.ok(plane instanceof Float64Array, "luminance plane must be float64");
});

test("a flat field has no grain and no banding", () => {
  const r = measureGrain(
    frame(() => 128),
    W,
    H,
  );
  assert.equal(r.grain, 0);
  assert.equal(r.band, 0);
  assert.equal(r.quietGrain, 0);
});

test("a smooth gradient scores near zero despite a large luminance range", () => {
  // This is the property that makes grain the right measure. The frame spans
  // nearly the whole 0-255 range, and is still not grainy.
  const r = measureGrain(
    frame((x) => Math.round((x / (W - 1)) * 255)),
    W,
    H,
  );
  assert.ok(r.grain < 1, `smooth gradient scored ${r.grain} on grain`);
  // ...while banding does see it: neighbouring pixels step by about 4 units.
  assert.ok(r.band > 1, `gradient should band, scored ${r.band}`);
});

test("noise scores high on grain, and far above a gradient of the same range", () => {
  const grainy = measureGrain(
    frame((x, y) => Math.round(noise(x, y) * 255)),
    W,
    H,
  );
  const smooth = measureGrain(
    frame((x) => Math.round((x / (W - 1)) * 255)),
    W,
    H,
  );
  assert.ok(grainy.grain > 30, `noise scored only ${grainy.grain}`);
  assert.ok(
    grainy.grain > smooth.grain * 20,
    `noise ${grainy.grain} must dominate gradient ${smooth.grain}`,
  );
});

test("banding separates an 8-bit gradient from grain", () => {
  const smooth = measureGrain(
    frame((x) => Math.round((x / (W - 1)) * 255)),
    W,
    H,
  );
  // A gradient bands without being grainy: that is the distinction the two
  // figures exist to draw, and why one number could not do this job.
  assert.ok(
    smooth.band > smooth.grain * 2,
    `band ${smooth.band} vs grain ${smooth.grain}`,
  );
});

test("the flattest tile is found where the frame is quietest", () => {
  // Noise in the left half only. The flattest tile must land on the right.
  const px = frame((x, y) => (x < W / 2 ? Math.round(noise(x, y) * 255) : 128));
  const box = flattestTile(luminancePlane(px, W, H), W, H);
  assert.ok(
    box[0] >= W / 2,
    `flattest tile started at x=${box[0]}, expected the calm half`,
  );
});

test("quiet grain reads the ground, not the type on top of it", () => {
  // A card-shaped frame: grainy ground everywhere, plus a bright block
  // standing in for a headline in the upper middle. The whole-frame figure is
  // pulled up by the block's edges; the quiet figure must not be.
  const ground = (x, y) => 100 + Math.round(noise(x, y) * 40);
  const px = frame((x, y) =>
    y > H * 0.3 && y < H * 0.5 && x > W * 0.2 && x < W * 0.8
      ? 250
      : ground(x, y),
  );
  const r = measureGrain(px, W, H);
  assert.ok(
    r.quietGrain < r.grain,
    `quiet ${r.quietGrain} should be under whole-frame ${r.grain}`,
  );
  assert.ok(
    r.quietGrain > 5,
    "the ground is genuinely grainy and must read as such",
  );
});

test("the report names what it measured", () => {
  const r = measureGrain(
    frame(() => 128),
    W,
    H,
  );
  assert.equal(r.size, `${W}x${H}`);
  assert.equal(r.quietBox.length, 4);
});

test("grainWithin refuses a ground that is too solid, in the review's own words", () => {
  const flat = measureGrain(
    frame(() => 128),
    W,
    H,
  );
  const verdict = grainWithin(flat, { max: 12, min: 2 });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /too solid/);
  assert.equal(verdict.measured, 0);
});

test("grainWithin refuses a ground that is too noisy", () => {
  const loud = measureGrain(
    frame((x, y) => Math.round(noise(x, y) * 255)),
    W,
    H,
  );
  const verdict = grainWithin(loud, { max: 12, min: 2 });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /too noisy/);
});

test("grainWithin passes a ground inside the kit range", () => {
  const ok = measureGrain(
    frame((x, y) => 120 + Math.round(noise(x, y) * 20)),
    W,
    H,
  );
  const verdict = grainWithin(ok, { max: 40, min: 1 });
  assert.equal(verdict.pass, true, `measured ${verdict.measured}`);
  assert.equal(verdict.reason, undefined);
});

test("a region with no interior is refused rather than scored as zero", () => {
  assert.throws(
    () =>
      measureGrain(
        frame(() => 128, 2, 2),
        2,
        2,
      ),
    /no measurable interior/,
  );
});
