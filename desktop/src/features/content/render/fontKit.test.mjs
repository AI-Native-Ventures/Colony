// The inlined kit face, tested without a browser.
//
// What is being pinned here is the reason the face is inlined at all: a font
// referenced by name or URL inside foreignObject falls back silently, so the
// rule must carry the bytes, and the family must be one the ambient document
// does not already provide.

import assert from "node:assert/strict";
import test from "node:test";

import { KIT_FAMILY, kitFontFaceCss } from "./fontKit.ts";

const PAYLOAD = "d09GMgABAAAAAA";

test("the rule carries the bytes as a data: URI, never a URL", () => {
  const css = kitFontFaceCss(PAYLOAD);
  assert.match(
    css,
    /src:url\(data:font\/woff2;base64,d09GMgABAAAAAA\) format\("woff2"\)/,
  );
  assert.doesNotMatch(css, /url\(["']?https?:/);
});

test("the family is not the one the app already loads", () => {
  assert.notEqual(KIT_FAMILY, "Inter");
  assert.match(kitFontFaceCss(PAYLOAD), /font-family:"Inter Kit"/);
});

test("the whole variable weight range is declared, so 600 is rendered not synthesised", () => {
  assert.match(kitFontFaceCss(PAYLOAD), /font-weight:100 900/);
});

test("an empty payload is refused rather than producing a rule that falls back", () => {
  assert.throws(() => kitFontFaceCss(""), /empty payload/);
});

test("a payload that is not base64 is refused", () => {
  assert.throws(() => kitFontFaceCss("not base64!"), /not base64/);
});
