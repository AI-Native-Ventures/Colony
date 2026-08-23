// The render pipeline: text gates, then pixels, then reports bound to pixels.
//
// Two properties matter more than the rest here, and both are asserted with a
// spy on the renderer rather than by inspecting output:
//
//   1. A failing card never reaches the renderer. That is what makes a bad
//      card free, and it is the whole reason the gates are split pre and post.
//   2. Every slide gets its own report, naming its own bytes, carrying all six
//      required gate ids. A report missing one leaves the post unable to be
//      ready, and a report naming the wrong hash is refused at ingest.

import assert from "node:assert/strict";
import test from "node:test";

import {
  contrastGateEntry,
  fontGateEntry,
  grainGateEntry,
  preRender,
  renderCard,
  reportPasses,
  slideReport,
} from "./pipeline.ts";

const REQUIRED = [
  "canvas",
  "claims",
  "contrast",
  "fonts",
  "grain",
  "housestyle",
];

const KIT = {
  bannedWords: ["synergy"],
  canvases: [{ h: 1350, name: "post", w: 1080 }],
};
const RANGE = { max: 40, min: 1 };
const AT = "2026-08-23T12:00:00.000Z";
const RENDERER = { engine: "webkit", version: "1" };

const card = (over = {}) => ({
  alt: "A violet card.",
  caption: "Colony is a workspace.",
  headline: "Run your company with AI agents.",
  ...over,
});

const passingClaims = {
  bar: 0,
  detail: "Every claim checked against its source.",
  id: "claims",
  measured: { blocked: [], warnings: [] },
  status: "pass",
};
const failingClaims = { ...passingClaims, bar: 1, status: "fail" };

const slide = (hash, over = {}) => ({
  contrast: [
    {
      color: "rgb(255,255,255)",
      label: "headline",
      ratio: 9.66,
      rawRatio: 9.4,
      worstBackground: "rgb(59, 31, 110)",
    },
  ],
  font: { delta: 20.1, pass: true },
  grain: {
    band: 1,
    grain: 9,
    quietBand: 1,
    quietBox: [0, 0, 1, 1],
    quietGrain: 8,
    size: "1080x1350",
  },
  height: 1350,
  png: new Uint8Array([1, 2, 3]),
  sha256: hash,
  width: 1080,
  ...over,
});

const A = "a".repeat(64);
const B = "b".repeat(64);

// --- the pre-render gate ----------------------------------------------------

test("a clean card is allowed to render", () => {
  const r = preRender(card(), 1080, 1350, KIT, passingClaims);
  assert.equal(r.ok, true);
  assert.equal(r.gates.length, 3, "canvas, housestyle and claims");
});

test("an unsourced claim stops the render before any pixels exist", () => {
  const r = preRender(card(), 1080, 1350, KIT, failingClaims);
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].id, "claims");
});

test("a house-rule breach stops the render too", () => {
  const r = preRender(
    card({ headline: "Pure synergy." }),
    1080,
    1350,
    KIT,
    passingClaims,
  );
  assert.equal(r.ok, false);
  assert.equal(r.blocking[0].id, "housestyle");
});

test("a failing card never reaches the renderer", async () => {
  // The property that makes a bad card free. Asserted on the renderer itself,
  // because checking the output would not prove the work was skipped.
  let called = 0;
  const out = await renderCard(
    card(),
    1080,
    1350,
    KIT,
    failingClaims,
    RANGE,
    async () => {
      called++;
      return [slide(A)];
    },
    AT,
    RENDERER,
  );
  assert.equal(called, 0, "the renderer must not run for a blocked card");
  assert.equal(out.status, "blocked");
  assert.equal(out.blocking.length, 1);
});

// --- reports ----------------------------------------------------------------

test("every slide gets its own report, naming its own bytes", async () => {
  const out = await renderCard(
    card(),
    1080,
    1350,
    KIT,
    passingClaims,
    RANGE,
    async () => [slide(A), slide(B)],
    AT,
    RENDERER,
  );
  assert.equal(out.status, "rendered");
  assert.equal(out.reports.length, 2);
  assert.equal(out.reports[0].imageHash, A);
  assert.equal(out.reports[1].imageHash, B);
});

test("every report carries all six required gate ids", async () => {
  // A report missing one leaves the post unable to be ready, and the pre-render
  // gates are card-level, so they have to be copied into each slide's report.
  const out = await renderCard(
    card(),
    1080,
    1350,
    KIT,
    passingClaims,
    RANGE,
    async () => [slide(A), slide(B)],
    AT,
    RENDERER,
  );
  for (const report of out.reports) {
    const ids = report.gates.map((g) => g.id).sort();
    assert.deepEqual(
      ids,
      REQUIRED,
      `report ${report.imageHash.slice(0, 6)} is incomplete`,
    );
  }
});

test("one slide failing its pixel gates does not fail the others", async () => {
  const out = await renderCard(
    card(),
    1080,
    1350,
    KIT,
    passingClaims,
    RANGE,
    async () => [
      slide(A),
      slide(B, {
        contrast: [
          {
            color: "rgb(255,255,255)",
            label: "headline",
            ratio: 2.7,
            rawRatio: 2.7,
            worstBackground: "rgb(200, 180, 220)",
          },
        ],
      }),
    ],
    AT,
    RENDERER,
  );
  assert.equal(reportPasses(out.reports[0]), true);
  assert.equal(reportPasses(out.reports[1]), false);
});

test("two slides sharing a hash are refused rather than reported", async () => {
  // Two slides with one hash would let a report describe the wrong bytes, and
  // the carousel's approval digest could not tell them apart.
  await assert.rejects(
    renderCard(
      card(),
      1080,
      1350,
      KIT,
      passingClaims,
      RANGE,
      async () => [slide(A), slide(A)],
      AT,
      RENDERER,
    ),
    /share the hash/,
  );
});

test("a renderer returning nothing is an error, not an empty pass", async () => {
  await assert.rejects(
    renderCard(
      card(),
      1080,
      1350,
      KIT,
      passingClaims,
      RANGE,
      async () => [],
      AT,
      RENDERER,
    ),
    /no slides/,
  );
});

// --- the pixel gate entries -------------------------------------------------

test("contrast reports the worst run and names it", () => {
  const g = contrastGateEntry([
    {
      color: "rgb(255,255,255)",
      label: "headline",
      ratio: 9.66,
      rawRatio: 9.4,
      worstBackground: "rgb(59, 31, 110)",
    },
    {
      color: "rgb(255,255,255)",
      label: "foot",
      ratio: 4.9,
      rawRatio: 4.8,
      worstBackground: "rgb(120, 90, 170)",
    },
  ]);
  assert.equal(g.status, "pass");
  assert.equal(g.measured, 4.9, "the worst run sets the card's figure");
  assert.match(g.detail, /foot/);
});

test("contrast under the floor fails and says what it measured against", () => {
  const g = contrastGateEntry([
    {
      color: "rgb(255,255,255)",
      label: "headline",
      ratio: 2.7,
      rawRatio: 2.7,
      worstBackground: "rgb(200, 180, 220)",
    },
  ]);
  assert.equal(g.status, "fail");
  assert.match(g.detail, /rgb\(200, 180, 220\)/);
  assert.match(g.detail, /4\.5:1 floor/);
});

test("grain outside the kit range fails in the review's own words", () => {
  const flat = {
    band: 0,
    grain: 0,
    quietBand: 0,
    quietBox: [0, 0, 1, 1],
    quietGrain: 0,
    size: "1080x1350",
  };
  const g = grainGateEntry(flat, { max: 40, min: 2 });
  assert.equal(g.status, "fail");
  assert.match(g.detail, /too solid/);
});

test("a silent font fallback fails the fonts gate", () => {
  const g = fontGateEntry({
    delta: 0,
    pass: false,
    reason: "the kit face did not reach the raster",
  });
  assert.equal(g.status, "fail");
  assert.equal(g.measured, 0);
});

test("a report names when it was rendered and by what", () => {
  const r = slideReport(slide(A), [passingClaims], RANGE, AT, RENDERER);
  assert.equal(r.renderedAt, AT);
  assert.deepEqual(r.renderer, RENDERER);
  assert.equal(r.imageHash, A);
});
