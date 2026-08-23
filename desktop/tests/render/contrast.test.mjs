// The contrast gate's pixel maths, tested without a browser.
//
// Everything here is pure: pixels in, numbers out. The browser-side parts
// (collectRuns, the plate rasterisation) are exercised by the capture tests;
// what matters most is that the arithmetic agrees with WCAG on values whose
// answers are known independently, because a sampler that is wrong by a little
// passes cards that should fail.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(
  new URL("../../src/features/content/render/contrast.ts", import.meta.url),
);
const {
  AA_BODY,
  contrastRatio,
  measureRuns,
  parseRgb,
  relativeLuminance,
  worstInBox,
  worstRatio,
} = await import(
  `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(SRC, "utf8")))}`
);

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
// The spike's pair. Its measured ratio, computed independently in the spike
// and again here, is 13.07:1.
const VIOLET = [59, 31, 110];

test("relative luminance matches the WCAG anchors", () => {
  assert.equal(relativeLuminance(BLACK), 0);
  assert.equal(relativeLuminance(WHITE), 1);
});

test("contrast ratio matches values known independently", () => {
  // The extremes are exact under the formula.
  assert.equal(contrastRatio(WHITE, BLACK), 21);
  assert.equal(contrastRatio(BLACK, WHITE), 21);
  assert.equal(contrastRatio(WHITE, WHITE), 1);
  // The spike rendered white on this violet and measured 13.07 off real
  // pixels. Arithmetic and rasteriser agreeing is the point of the check.
  assert.equal(Math.round(contrastRatio(WHITE, VIOLET) * 100) / 100, 13.07);
});

test("ratio is symmetric in its arguments", () => {
  assert.equal(contrastRatio(WHITE, VIOLET), contrastRatio(VIOLET, WHITE));
});

test("parseRgb reads rgb() and rgba() alike", () => {
  assert.deepEqual(parseRgb("rgb(59, 31, 110)"), VIOLET);
  assert.deepEqual(parseRgb("rgba(59, 31, 110, 0.85)"), VIOLET);
});

/** A solid plate of one colour, plus optional brighter specks. */
function plate(width, height, [r, g, b], specks = []) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  for (const [x, y, colour] of specks) {
    const i = (y * width + x) * 4;
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
  }
  return px;
}

const run = (over = {}) => ({
  alpha: 1,
  box: { height: 20, width: 20, x: 0, y: 0 },
  color: "rgb(255, 255, 255)",
  label: "headline",
  ...over,
});

test("worstInBox finds the WCAG ratio on a uniform ground", () => {
  const px = plate(40, 40, VIOLET);
  const got = worstInBox(px, 40, 40, run(), 1, 1);
  assert.equal(Math.round(got.ratio * 100) / 100, 13.07);
  assert.deepEqual(got.background, VIOLET);
});

test("the worst single pixel wins, not the average", () => {
  // One near-white speck inside an otherwise dark box. White type over it is
  // nearly invisible, and that one pixel must decide the verdict.
  const px = plate(40, 40, VIOLET, [[5, 5, [250, 250, 250]]]);
  const got = worstInBox(px, 40, 40, run(), 1, 1);
  assert.ok(
    got.ratio < 1.1,
    `expected the speck to dominate, got ${got.ratio}`,
  );
  assert.deepEqual(got.background, [250, 250, 250]);
});

test("a sampling stride can step over the worst pixel, which is why the gate blurs", () => {
  // The same speck at an odd coordinate, sampled every 2px. This documents a
  // real property rather than asserting a bug: point sampling can miss a
  // one-pixel feature, and it is why the gated figure is measured on a
  // low-passed plate where a speck has been spread into its neighbours.
  const px = plate(40, 40, VIOLET, [[5, 5, [250, 250, 250]]]);
  const strided = worstInBox(px, 40, 40, run(), 1, 2);
  assert.equal(Math.round(strided.ratio * 100) / 100, 13.07);
});

test("translucent type composites per pixel rather than measuring its opaque colour", () => {
  const px = plate(40, 40, VIOLET);
  const opaque = worstInBox(px, 40, 40, run(), 1, 1);
  const faded = worstInBox(px, 40, 40, run({ alpha: 0.5 }), 1, 1);
  assert.ok(
    faded.ratio < opaque.ratio,
    `half-opacity type must measure worse than opaque: ${faded.ratio} vs ${opaque.ratio}`,
  );
  // Folding alpha is what stops a card passing on a ratio the eye never gets.
  assert.ok(faded.ratio > 1);
});

test("an empty box is refused rather than silently scoring nothing", () => {
  const px = plate(40, 40, VIOLET);
  assert.throws(
    () =>
      worstInBox(
        px,
        40,
        40,
        run({ box: { height: 0, width: 0, x: 0, y: 0 } }),
        1,
        1,
      ),
    /empty box/,
  );
});

test("measureRuns reports the gated figure and the raw one separately", () => {
  const soft = plate(40, 40, VIOLET);
  const raw = plate(40, 40, VIOLET, [[5, 5, [250, 250, 250]]]);
  const [m] = measureRuns([run()], soft, raw, 40, 40, { step: 1 });
  assert.equal(m.ratio, 13.07, "gated on the low-passed plate");
  assert.ok(m.rawRatio < 1.1, "raw worst pixel reported, not gated on");
  assert.equal(m.label, "headline");
  assert.equal(m.worstBackground, "rgb(59, 31, 110)");
});

test("a card with no measured runs is refused, never passed", () => {
  const px = plate(40, 40, VIOLET);
  assert.throws(() => measureRuns([], px, px, 40, 40), /no \[data-contrast\]/);
});

test("worstRatio picks the failing run out of a passing card", () => {
  const soft = plate(80, 40, VIOLET);
  const ms = measureRuns(
    [
      run({ label: "headline" }),
      run({
        box: { height: 20, width: 20, x: 40, y: 0 },
        color: "rgb(120, 90, 170)",
        label: "foot",
      }),
    ],
    soft,
    soft,
    80,
    40,
    { step: 1 },
  );
  const worst = worstRatio(ms);
  assert.ok(worst < ms[0].ratio, "the dimmer run must set the card's figure");
  assert.ok(worst < AA_BODY, "and this pair is genuinely below the bar");
});
