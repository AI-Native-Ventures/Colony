import { expect, test } from "@playwright/test";
import { build } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The card actually draws, in this engine.
 *
 * Every gate's maths is unit-tested in node, and none of that proves a card
 * renders: the capture path goes through `foreignObject` rasterisation, which
 * has a history of failing in WebKit, and the packaged macOS app is WKWebView.
 * So this runs on both engines. A Chromium-only pass would prove nothing about
 * the app, and the original spike's first failure looked exactly like "WebKit
 * cannot do this" when the real cause was a `blob:` URL tainting the canvas in
 * both.
 *
 * The bundle is built here rather than imported, because the renderer is app
 * source rather than something the preview build exposes on `window`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const CARD = {
  accent: "without the headcount",
  family: "night" as const,
  headline: "Run a company without the headcount",
  hues: ["violet", "pink"],
  layout: "statement",
  slug: "engine-proof",
};

let bundle: string;

test.beforeAll(async () => {
  const result = await build({
    build: {
      // The kit face must land in the bundle as a data: URI: fetching it from
      // a hashed asset path would need a server this page does not have.
      assetsInlineLimit: 8_000_000,
      lib: {
        entry: path.join(here, "harness/renderHarness.ts"),
        fileName: "render-harness",
        formats: ["iife"],
        name: "ColonyRenderHarness",
      },
      minify: false,
      write: false,
    },
    configFile: false,
    logLevel: "silent",
    root: path.join(here, "../.."),
  });
  const output = Array.isArray(result) ? result[0].output : [];
  const chunk = output.find((entry) => entry.type === "chunk");
  if (chunk?.type !== "chunk") {
    throw new Error("the render harness produced no chunk");
  }
  bundle = chunk.code;
});

test.beforeEach(async ({ page }) => {
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => "__COLONY_RENDER_SLIDE__" in window);
});

test("every layout the kit advertises actually draws", async ({ page }) => {
  // A kit that lists a template the renderer cannot build hands an agent a
  // card that throws at render time, which is the failure this pins.
  for (const layout of ["statement", "poster"]) {
    const slide = await page.evaluate(
      (card) => window.__COLONY_RENDER_SLIDE__(card),
      { ...CARD, badge: "Week 1", layout, slug: `proof-${layout}` },
    );
    expect(slide.pixelVariance, layout).toBeGreaterThan(100);
    expect(
      Math.min(...slide.contrast.map((run) => run.ratio)),
      layout,
    ).toBeGreaterThanOrEqual(4.5);
    expect(slide.font.pass, layout).toBe(true);
  }
});

test("a customer's own kit changes the pixels, not just the record", async ({
  page,
}) => {
  // The whole point of storing a brand kit. Until resolveGroundHues took a
  // kit, a derived one changed nothing: cards still rendered, always in
  // Colony's colours, which looks identical to working.
  const TEAL = {
    canvases: [{ h: 1350, name: "ig-portrait", w: 1080 }],
    hues: [
      {
        base: "#0f766e",
        name: "violet",
        ramp: [
          "#04241f",
          "#07463d",
          "#0a675a",
          "#3fbfae",
          "#7fd6cb",
          "#bfeae4",
          "#eff9f7",
          "#33ccb9",
        ],
      },
    ],
    id: "customer",
    marks: [],
    rules: { claim_strictness: "strict", contrast_floor: 4.5, raw: {} },
    source: { type: "manual" },
    templates: ["statement"],
    type: null,
    version: "1",
  };

  const colony = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    { ...CARD, hues: ["violet"], slug: "kit-colony" },
  );
  const customer = await page.evaluate(
    ([card, kit]) => window.__COLONY_RENDER_SLIDE__(card as never, kit),
    [{ ...CARD, hues: ["violet"], slug: "kit-colony" }, TEAL] as const,
  );

  // Same card, same slug, same seed: only the kit differs, so identical bytes
  // would mean the kit was ignored.
  expect(customer.sha256).not.toBe(colony.sha256);
  expect(customer.pixelVariance).toBeGreaterThan(100);
  expect(
    Math.min(...customer.contrast.map((run) => run.ratio)),
  ).toBeGreaterThanOrEqual(4.5);
});

test("a card rasterises to pixels rather than to a blank canvas", async ({
  page,
}) => {
  const slide = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );

  expect(slide.width).toBe(1080);
  expect(slide.height).toBe(1350);
  // A blank canvas still encodes a valid PNG, so byte length proves nothing.
  // The spike measured 1151 on a painted card against 0 on a blank one.
  expect(slide.pixelVariance).toBeGreaterThan(100);
  expect(slide.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the type is measured against the ground it actually sits on", async ({
  page,
}) => {
  const slide = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );

  expect(slide.contrast.length).toBeGreaterThan(0);
  const worst = Math.min(...slide.contrast.map((run) => run.ratio));
  // Not a tautology: the plate frame hides the runs, so this reads the
  // ground's pixels. A card whose type failed here is exactly what the gate
  // caught eight times in the launch build.
  expect(worst).toBeGreaterThanOrEqual(4.5);
});

test("the kit face reaches the raster, not just the DOM", async ({ page }) => {
  const slide = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );

  // Inside foreignObject a font referenced by name or URL falls back silently
  // while every DOM measurement still reports the intended one. The delta is
  // between two rasters, which is the only thing that proves the bytes.
  expect(slide.font.reason ?? "").toBe("");
  expect(slide.font.pass).toBe(true);
  expect(slide.font.delta).toBeGreaterThanOrEqual(2);
});

test("the ground carries grain, so the card is not a flat fill", async ({
  page,
}) => {
  const slide = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );

  expect(slide.grain.quietGrain).toBeGreaterThan(0);
});

test("the same card twice produces the same bytes", async ({ page }) => {
  const first = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );
  const second = await page.evaluate(
    (card) => window.__COLONY_RENDER_SLIDE__(card),
    CARD,
  );
  // A report names a hash. If one card produced two hashes, no report could
  // ever describe the bytes an owner approved.
  expect(second.sha256).toBe(first.sha256);
});
