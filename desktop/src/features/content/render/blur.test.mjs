// The contrast gate's low-pass, tested without a browser.
//
// The property that matters is not "it looks softer": it is that a single
// noise grain stops deciding a card's verdict while the ground it sits on
// keeps its colour. So the tests are built from frames whose answer is known
// by construction — a flat field must survive untouched, one hot pixel must
// be pulled most of the way back to its ground, and a large block's interior
// must not move at all.

import assert from "node:assert/strict";
import test from "node:test";

import { boxBlurRgba } from "./blur.ts";

const W = 32;
const H = 32;

function frame(fill = 0) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = fill;
    px[i * 4 + 1] = fill;
    px[i * 4 + 2] = fill;
    px[i * 4 + 3] = 255;
  }
  return px;
}

const at = (px, x, y, c = 0) => px[(y * W + x) * 4 + c];

test("a flat field is unchanged, so a blurred plate still reports its ground", () => {
  const flat = frame(90);
  const blurred = boxBlurRgba(flat, W, H, 2);
  for (let i = 0; i < flat.length; i++) {
    assert.equal(blurred[i], flat[i]);
  }
});

test("radius 0 copies rather than aliasing the caller's buffer", () => {
  const px = frame(40);
  const out = boxBlurRgba(px, W, H, 0);
  out[0] = 255;
  assert.equal(px[0], 40);
});

test("one hot pixel is pulled back towards its ground", () => {
  const px = frame(50);
  const idx = (16 * W + 16) * 4;
  px[idx] = 250;
  px[idx + 1] = 250;
  px[idx + 2] = 250;
  const blurred = boxBlurRgba(px, W, H, 2);
  const centre = at(blurred, 16, 16);
  assert.ok(centre < 90, `one grain still reads ${centre}, near its raw 250`);
  assert.ok(centre > 50, `the grain vanished entirely (${centre})`);
});

test("the interior of a large block keeps its colour", () => {
  const px = frame(20);
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      const i = (y * W + x) * 4;
      px[i] = 200;
      px[i + 1] = 200;
      px[i + 2] = 200;
    }
  }
  const blurred = boxBlurRgba(px, W, H, 2);
  assert.equal(at(blurred, 16, 16), 200);
});

test("alpha is carried through, so blurring never eats the frame's edge", () => {
  const px = frame(70);
  const blurred = boxBlurRgba(px, W, H, 2);
  for (let i = 0; i < W * H; i++) {
    assert.equal(blurred[i * 4 + 3], 255);
  }
});

test("a frame whose byte count is not the stated size is refused", () => {
  assert.throws(
    () => boxBlurRgba(new Uint8ClampedArray(16), W, H, 2),
    /not a 32x32 RGBA frame/,
  );
});
