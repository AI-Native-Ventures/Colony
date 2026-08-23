// End-to-end proof: a real launch card, rendered and measured in WebKit.
//
// Every other test in this directory checks one piece against values chosen to
// make the arithmetic checkable. This one runs the whole path — composition,
// ground, font, rasterisation, contrast — on a card that actually shipped, and
// compares the number against what the launch build measured for it.
//
// That comparison is the point. The launch cards measured 6.50:1 to 9.96:1
// with the original Playwright renderer. If this port lands in that band the
// two renderers agree; a wildly different figure would mean the measurement is
// wrong rather than the card, and would be invisible to every unit test here
// because each of those is internally consistent.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";

const DIR = new URL("../../src/features/content/render/", import.meta.url);
const read = (name) =>
  stripTypeScriptTypes(readFileSync(fileURLToPath(new URL(name, DIR)), "utf8"));

/** Every render module, concatenated with its local imports stripped. */
const BUNDLE = [
  "color.ts",
  "geometry.ts",
  "kit.ts",
  "colonyKit.ts",
  "atmosphere.ts",
  "compositions.ts",
  "capture.ts",
  "grain.ts",
  "contrast.ts",
  "fontGate.ts",
]
  .map(read)
  .map((s) => s.replace(/^import[^;]*;$/gm, ""))
  .join("\n");

const FONT_B64 = readFileSync(
  new URL(
    "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    import.meta.url,
  ),
).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter Kit";src:url(data:font/woff2;base64,${FONT_B64}) format("woff2");font-weight:100 900;font-display:block}`;

// w1-wed-thread, as it shipped: statement layout, dawn family, amber and pink.
// The launch build measured its worst run at 9.66:1.
const CARD = {
  family: "dawn",
  headline: "Your team and your agents\nwork in the same thread.",
  hues: ["amber", "pink"],
  layout: "statement",
  size: 54,
  slug: "w1-wed-thread",
};

const LAUNCH_FLOOR = 6.5;
const LAUNCH_CEILING = 9.96;

async function renderAndMeasure(card) {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({
      viewport: { height: 900, width: 1080 },
    });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`,
      { waitUntil: "load" },
    );
    await page.addScriptTag({
      content: `${BUNDLE}
globalThis.__render = { cardHtml, cardCss, captureCard, collectRuns, measureRuns, worstRatio, measureGrain, PLATE_CSS, CANVAS_W, CANVAS_H, AA_BODY };`,
      type: "module",
    });
    return await page.evaluate(
      async ({ card, fontFace }) => {
        const R = globalThis.__render;
        const W = R.CANVAS_W;
        const H = R.CANVAS_H;

        // The card, live in the document, so runs can be measured with layout.
        const markup = R.cardHtml(card, { fontFaceCss: fontFace });
        const host = document.createElement("div");
        host.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
        host.innerHTML = markup;
        document.body.appendChild(host);
        await document.fonts.load(`96px "Inter Kit"`, card.headline);
        await document.fonts.ready;

        const runs = R.collectRuns(host);
        const css = R.cardCss(fontFace);
        const body = host.querySelector("body")?.innerHTML ?? host.innerHTML;

        // Frame one: the card. Frame two: the same card with the measured runs
        // hidden, which is the background of record.
        const painted = await R.captureCard(body, css, W, H);
        const plate = await R.captureCard(body, `${css}\n${R.PLATE_CSS}`, W, H);

        const pixelsOf = async (png) => {
          const blob = new Blob([png], { type: "image/png" });
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          return ctx.getImageData(0, 0, W, H).data;
        };
        const platePixels = await pixelsOf(plate.png);

        const measurements = R.measureRuns(runs, platePixels, platePixels, W, H, {
          step: 2,
        });
        const grain = R.measureGrain(await pixelsOf(painted.png), W, H);

        return {
          bar: R.AA_BODY,
          grain: { grain: grain.grain, quietGrain: grain.quietGrain },
          measurements,
          pixelVariance: painted.pixelVariance,
          runs: runs.length,
          sha256: painted.sha256,
          size: `${painted.width}x${painted.height}`,
          worst: R.worstRatio(measurements),
        };
      },
      { card, fontFace: FONT_FACE },
    );
  } finally {
    await browser.close();
  }
}

test("a real launch card renders and measures inside the band the launch build shipped", async () => {
  const out = await renderAndMeasure(CARD);

  console.log(`\n  card            ${CARD.slug} (${CARD.layout}, ${CARD.family}, ${CARD.hues.join("+")})`);
  console.log(`  canvas          ${out.size}`);
  console.log(`  sha256          ${out.sha256}`);
  console.log(`  pixel variance  ${out.pixelVariance}`);
  console.log(`  contrast runs   ${out.runs}`);
  for (const m of out.measurements) {
    console.log(`    ${m.label.padEnd(16)} ${m.ratio}:1 on ${m.worstBackground}`);
  }
  console.log(`  worst run       ${out.worst}:1 against a ${out.bar}:1 floor`);
  console.log(`  grain           ${out.grain.grain} whole, ${out.grain.quietGrain} quiet\n`);

  assert.ok(out.runs > 0, "the card must carry measurable [data-contrast] runs");
  assert.ok(out.pixelVariance > 100, `canvas looks blank: variance ${out.pixelVariance}`);
  assert.ok(
    out.worst >= out.bar,
    `worst run ${out.worst}:1 is under the ${out.bar}:1 floor`,
  );
  assert.ok(
    out.worst >= LAUNCH_FLOOR && out.worst <= LAUNCH_CEILING + 1,
    `worst run ${out.worst}:1 sits outside the launch build's ${LAUNCH_FLOOR}-${LAUNCH_CEILING}:1 band, ` +
      `which means the measurement disagrees with the renderer that shipped these cards`,
  );
});
