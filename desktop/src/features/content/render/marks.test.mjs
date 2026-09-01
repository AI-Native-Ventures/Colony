import assert from "node:assert/strict";
import test from "node:test";

import { cardHtml } from "./compositions.ts";
import {
  antMark,
  chooseKitMark,
  fallbackMark,
  imageMark,
  isColonyKit,
  markDataUri,
  noMark,
  sniffImageMime,
} from "./marks.ts";

const kit = (overrides = {}) => ({
  canvases: [{ h: 1350, name: "post", w: 1080 }],
  hues: [{ base: "#5b2ee5", name: "violet", ramp: [] }],
  id: "acme",
  marks: [],
  rules: { claim_strictness: "strict", contrast_floor: null, raw: {} },
  source: { type: "scan", url: "https://acme.example" },
  templates: ["statement", "poster"],
  type: null,
  version: "1",
  ...overrides,
});

test("mime sniffing reads magic bytes, not filenames", () => {
  assert.equal(
    sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2])),
    "image/png",
  );
  assert.equal(
    sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  const webp = new Uint8Array(16);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(sniffImageMime(webp), "image/webp");
  assert.equal(
    sniffImageMime(new TextEncoder().encode('  <svg xmlns="x"></svg>')),
    "image/svg+xml",
  );
  assert.equal(sniffImageMime(Uint8Array.from([1, 2, 3, 4])), null);
});

test("a data URI round-trips the bytes and never uses blob:", () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  const uri = markDataUri(bytes, "image/png");
  assert.ok(uri.startsWith("data:image/png;base64,"));
  const decoded = Uint8Array.from(atob(uri.split(",")[1]), (char) =>
    char.charCodeAt(0),
  );
  assert.deepEqual([...decoded], [...bytes]);
});

test("mark choice prefers icon, then logo, then wordmark", () => {
  const marks = [
    { media_hash: "w", media_url: "u://w", role: "wordmark" },
    { media_hash: "l", media_url: "u://l", role: "logo" },
    { media_hash: "i", media_url: "u://i", role: "icon" },
  ];
  assert.equal(chooseKitMark(kit({ marks })).media_hash, "i");
  assert.equal(
    chooseKitMark(kit({ marks: marks.slice(0, 2) })).media_hash,
    "l",
  );
  assert.equal(
    chooseKitMark(kit({ marks: marks.slice(0, 1) })).media_hash,
    "w",
  );
  assert.equal(chooseKitMark(kit()), null);
});

test("only Colony's own kit may fall back to the ant", () => {
  assert.equal(isColonyKit(null), true);
  assert.equal(isColonyKit(kit({ id: "colony" })), true);
  assert.equal(
    isColonyKit(
      kit({
        source: { type: "scan", url: "https://colony.ainative.ventures" },
      }),
    ),
    true,
  );
  // The check is on the host, not a substring: a rival hosting at a path
  // that merely mentions the name must not inherit the ant.
  assert.equal(
    isColonyKit(
      kit({
        source: {
          type: "scan",
          url: "https://evil.example/colony.ainative.ventures",
        },
      }),
    ),
    false,
  );
  assert.equal(isColonyKit(kit()), false);

  assert.equal(fallbackMark(null), antMark);
  assert.equal(fallbackMark(kit()), noMark);
});

test("mark kinds render what they say", () => {
  assert.match(antMark("#ffffff"), /<svg/);
  assert.match(antMark("#ffffff"), /#ffffff/);
  assert.equal(noMark("#ffffff"), "");
  assert.equal(
    imageMark("data:image/png;base64,AA")("#ffffff"),
    '<img src="data:image/png;base64,AA" alt="">',
  );
});

const spec = {
  family: "night",
  headline: "One phrase.",
  hues: ["violet"],
  layout: "statement",
  slug: "take-1",
};

test("a card with no mark and no foot line closes with nothing", () => {
  const html = cardHtml(spec, { fontFaceCss: "", mark: noMark });
  assert.ok(!html.includes('class="lockup"'), "no empty lockup box");
});

test("a kit image mark reaches the card as an inline img", () => {
  const html = cardHtml(spec, {
    fontFaceCss: "",
    mark: imageMark("data:image/png;base64,AA"),
  });
  assert.ok(html.includes('<img src="data:image/png;base64,AA"'));
  assert.ok(!html.includes("<svg"), "the ant does not ride along");
});

test("the default mark is still the ant, for Colony's own cards", () => {
  const html = cardHtml(spec, { fontFaceCss: "" });
  assert.match(html, /<svg/);
});
