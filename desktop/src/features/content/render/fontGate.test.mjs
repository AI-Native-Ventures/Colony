// The font-fallback gate.
//
// The gate exists because a font referenced by name or URL inside a
// foreignObject falls back silently: the card renders, measures fine on
// contrast, and is wrong in the one way a customer notices. The obvious check,
// comparing text widths, proves the DOM measured differently and says nothing
// about the raster. So the gate compares two rasters, and these tests pin the
// arithmetic plus the stylesheet surgery that produces the control frame.

import assert from "node:assert/strict";
import test from "node:test";

import {
  FALLBACK_FLOOR,
  fontReachedRaster,
  meanAbsoluteDelta,
  stripFontFaces,
} from "./fontGate.ts";

const W = 40;
const H = 40;
const BOX = { height: 20, width: 20, x: 10, y: 10 };

function frame(paint) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = paint(x, y);
      const i = (y * W + x) * 4;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return px;
}

test("identical frames score zero: the same glyphs drawn twice", () => {
  const a = frame((x) => (x % 3 === 0 ? 240 : 40));
  const b = frame((x) => (x % 3 === 0 ? 240 : 40));
  assert.equal(meanAbsoluteDelta(a, b, W, H, BOX), 0);
});

test("different glyphs move the number", () => {
  const withFace = frame((x, y) => ((x + y) % 4 === 0 ? 250 : 30));
  const withoutFace = frame((x, y) => ((x + y) % 7 === 0 ? 250 : 30));
  const delta = meanAbsoluteDelta(withFace, withoutFace, W, H, BOX);
  assert.ok(delta > FALLBACK_FLOOR, `two different faces scored only ${delta}`);
});

test("the delta is measured inside the box, not across the whole frame", () => {
  // Frames that differ only OUTSIDE the text box must score zero, otherwise
  // the gate would pass on a ground change while the type fell back.
  const a = frame(() => 128);
  const b = frame((x, y) => (x < 5 || y < 5 ? 255 : 128));
  assert.equal(meanAbsoluteDelta(a, b, W, H, BOX), 0);
});

test("a silent fallback fails the gate, with the cause named", () => {
  const same = frame((x) => (x % 3 === 0 ? 240 : 40));
  const verdict = fontReachedRaster(same, same, W, H, BOX);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.delta, 0);
  assert.match(verdict.reason, /did not reach the raster/);
  assert.match(verdict.reason, /base64 data: URI/);
});

test("a face that reached the raster passes", () => {
  const withFace = frame((x, y) => ((x + y) % 4 === 0 ? 250 : 30));
  const withoutFace = frame((x, y) => ((x + y) % 7 === 0 ? 250 : 30));
  const verdict = fontReachedRaster(withFace, withoutFace, W, H, BOX);
  assert.equal(verdict.pass, true, `delta ${verdict.delta}`);
  assert.equal(verdict.reason, undefined);
});

test("the floor sits an order of magnitude under the spike's measurement", () => {
  // The spike measured 20.1 with the kit face against the same card drawn
  // without it. A floor tuned to that number would be brittle; a floor well
  // under it still separates different glyphs from resampling noise.
  assert.ok(
    FALLBACK_FLOOR < 20.1 / 5,
    `floor ${FALLBACK_FLOOR} is too close to the measurement`,
  );
  assert.ok(FALLBACK_FLOOR > 0, "a zero floor would pass a fallback");
});

test("mismatched frame sizes are refused rather than compared", () => {
  const a = frame(() => 128);
  const b = new Uint8ClampedArray(4);
  assert.throws(
    () => meanAbsoluteDelta(a, b, W, H, BOX),
    /not two rasters of one card/,
  );
});

test("an empty text box is refused rather than scored as zero", () => {
  const a = frame(() => 128);
  assert.throws(
    () => meanAbsoluteDelta(a, a, W, H, { height: 0, width: 0, x: 0, y: 0 }),
    /text box is empty/,
  );
});

// --- the control frame's stylesheet -----------------------------------------

test("stripFontFaces removes the face and leaves the rest intact", () => {
  const css = `@font-face{font-family:"Inter Kit";src:url(data:font/woff2;base64,AAAA) format("woff2")}
.card{background:#3b1f6e}`;
  const out = stripFontFaces(css);
  assert.ok(!out.includes("@font-face"), "the face must be gone");
  assert.ok(out.includes(".card{background:#3b1f6e}"), "the rest must survive");
});

test("stripFontFaces survives a semicolon inside a base64 payload", () => {
  // The same shape that truncated capture.ts's first parser: ";base64," puts a
  // semicolon inside a value, and a character-class parser stops there.
  const css = `@font-face{font-family:"K";src:url(data:font/woff2;base64,QUJDRA==) format("woff2");font-weight:100 900}
.a{color:#fff}`;
  const out = stripFontFaces(css);
  assert.equal(out.trim(), ".a{color:#fff}");
});

test("stripFontFaces removes every face, not just the first", () => {
  const css = `@font-face{font-family:"A";src:url(data:font/woff2;base64,AA==)}
.x{color:red}
@font-face{font-family:"B";src:url(data:font/woff2;base64,BB==)}
.y{color:blue}`;
  const out = stripFontFaces(css);
  assert.ok(!out.includes("@font-face"));
  assert.ok(out.includes(".x{color:red}"));
  assert.ok(out.includes(".y{color:blue}"));
});

test("a stylesheet with no faces comes back unchanged", () => {
  const css = ".card{background:#000}";
  assert.equal(stripFontFaces(css), css);
});
