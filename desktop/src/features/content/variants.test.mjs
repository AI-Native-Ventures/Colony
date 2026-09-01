import assert from "node:assert/strict";
import test from "node:test";

import { variantTakes } from "./variants.ts";

const kit = (overrides = {}) => ({
  canvases: [{ h: 1350, name: "post", w: 1080 }],
  hues: [
    { base: "#5b2ee5", name: "violet", ramp: [] },
    { base: "#e52ea8", name: "magenta", ramp: [] },
  ],
  id: "acme",
  marks: [],
  rules: { claim_strictness: "strict", contrast_floor: null, raw: {} },
  source: { type: "manual" },
  templates: ["statement", "poster"],
  type: null,
  version: "1",
  ...overrides,
});

const post = (style) => ({
  address: "camp:day-1",
  alt: null,
  assets: [],
  author: "a".repeat(64),
  campaign: "camp",
  caption: null,
  channel: null,
  claimFields: {},
  claims: [],
  eventId: "e".repeat(64),
  gateReports: [],
  hashtags: [],
  headline: "One phrase.",
  images: [],
  job: null,
  scheduledFor: "2026-09-07",
  slug: "day-1",
  status: "draft",
  style,
  styleVersion: null,
  updatedAt: 1,
  week: 1,
});

const drafted = {
  family: "night",
  hues: ["violet"],
  layout: "statement",
  raw: { family: "night", hues: ["violet"], layout: "statement" },
  variant: null,
};

test("a post with no style block offers no takes", () => {
  assert.deepEqual(variantTakes(post(null), kit()), []);
});

test("three takes: as drafted, the other layout, the other hue", () => {
  const takes = variantTakes(post(drafted), kit());
  assert.deepEqual(
    takes.map((take) => take.label),
    ["As drafted", "Bigger", "Different color"],
  );
  assert.equal(takes[1].style.layout, "poster");
  // The raw block follows the override, because it is what gets published.
  assert.equal(takes[1].style.raw.layout, "poster");
  assert.deepEqual(takes[2].style.hues, ["magenta"]);
  assert.deepEqual(takes[2].style.raw.hues, ["magenta"]);
});

test("a single-hue kit flips the mood instead of the color", () => {
  const takes = variantTakes(
    post(drafted),
    kit({ hues: [{ base: "#5b2ee5", name: "violet", ramp: [] }] }),
  );
  const last = takes[takes.length - 1];
  assert.equal(last.label, "Lighter");
  assert.equal(last.style.family, "dawn");
});

test("a carousel varies color only: per-slide layouts make a top-level flip a lie", () => {
  const carousel = {
    ...drafted,
    raw: { ...drafted.raw, slides: [{ headline: "A" }, { headline: "B" }] },
  };
  const takes = variantTakes(post(carousel), kit());
  assert.ok(!takes.some((take) => take.label === "Bigger"));
  assert.ok(takes.some((take) => take.label === "Different color"));
});

test("takes that would look identical are not offered twice", () => {
  // A kit whose only template is the drafted one, and whose only hue is the
  // drafted one: the family flip is the single real alternative.
  const takes = variantTakes(
    post(drafted),
    kit({
      hues: [{ base: "#5b2ee5", name: "violet", ramp: [] }],
      templates: ["statement"],
    }),
  );
  assert.equal(takes.length, 2);
  assert.deepEqual(
    takes.map((take) => take.label),
    ["As drafted", "Lighter"],
  );
});
