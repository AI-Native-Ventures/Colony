// Capture path proof: card markup -> PNG bytes inside WebKit, Tauri's engine.
//
// Runs the real capture.ts in a Playwright WebKit page (the spike's engine)
// and proves the canvas is not blank by PIXEL VARIANCE, not byte length: a
// blank canvas still encodes a perfectly valid PNG, so a size check passes on
// nothing. The second test demonstrates exactly that failure mode.
//
//   cd desktop && node --test tests/render/capture.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";

const CAPTURE_TS = fileURLToPath(
  new URL("../../src/features/content/render/capture.ts", import.meta.url),
);

// The kit face, repo-local via @fontsource-variable/inter so the test does
// not depend on a checkout of colony-social-kit. Inlined as base64 exactly
// the way build-posts.mjs line 281 inlines it.
const FONT_B64 = readFileSync(
  new URL(
    "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    import.meta.url,
  ),
).toString("base64");
const FONT_FACE = `@font-face{font-family:"Inter Kit";src:url(data:font/woff2;base64,${FONT_B64}) format("woff2");font-weight:100 900;font-display:block}`;

const W = 1080;
const H = 1350;
const GROUND = "#3b1f6e";
const INK = "#ffffff";

// Same ground/ink pair as the spike, whose measured pixel variance was 1151.
const CARD_CSS = `${FONT_FACE}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px}
body{background:#000}
.card{width:${W}px;height:${H}px;background:${GROUND};display:flex;align-items:center;justify-content:center}
.headline{font-family:"Inter Kit";font-weight:600;font-size:96px;line-height:1.05;color:${INK};letter-spacing:-0.02em}
`;
const CARD_HTML = `<div class="card"><div class="headline">Run your company with AI agents.</div></div>`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function withCapture(fn) {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body></body></html>`,
      { waitUntil: "load" },
    );
    const src = stripTypeScriptTypes(readFileSync(CAPTURE_TS, "utf8"));
    await page.addScriptTag({
      type: "module",
      content: `${src}\nglobalThis.__captureCard = captureCard;`,
    });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function captureInPage(page, cardHtml, css) {
  return page.evaluate(
    async ({ cardHtml, css, W, H }) => {
      const r = await globalThis.__captureCard(cardHtml, css, W, H);
      let b64 = "";
      for (let i = 0; i < r.png.length; i += 0x8000) {
        b64 += String.fromCharCode.apply(null, r.png.subarray(i, i + 0x8000));
      }
      return {
        b64,
        height: r.height,
        pixelVariance: r.pixelVariance,
        sha256: r.sha256,
        width: r.width,
      };
    },
    { cardHtml, css, W, H },
  );
}

test("sha256Hex matches node:crypto on known vectors", async () => {
  const { sha256Hex } = await import(CAPTURE_TS);
  const enc = new TextEncoder();
  assert.equal(
    sha256Hex(new Uint8Array(0)),
    createHash("sha256").update(new Uint8Array(0)).digest("hex"),
  );
  assert.equal(
    sha256Hex(enc.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const big = new Uint8Array(1_000_000).fill(7);
  assert.equal(sha256Hex(big), createHash("sha256").update(big).digest("hex"));
});

test("the inlined woff2 face parses and renders in WebKit before the capture relies on it", async () => {
  await withCapture(async (page) => {
    const probe = await page.evaluate(async (fontFace) => {
      const style = document.createElement("style");
      style.textContent = fontFace;
      document.head.appendChild(style);
      await document.fonts.ready;
      const mk = (family) => {
        const s = document.createElement("span");
        s.textContent = "Run your company with AI agents.";
        s.style.cssText = `font-size:96px;position:absolute;left:-9999px;top:-9999px;white-space:nowrap;font-family:${family}`;
        document.body.appendChild(s);
        return s;
      };
      const kit = mk('"Inter Kit"');
      const sys = mk('"Times New Roman",serif');
      const differ =
        Math.abs(
          kit.getBoundingClientRect().width - sys.getBoundingClientRect().width,
        ) > 1;
      const check = document.fonts.check('96px "Inter Kit"');
      kit.remove();
      sys.remove();
      style.remove();
      return { check, differ };
    }, FONT_FACE);
    assert.equal(
      probe.check,
      true,
      "document.fonts.check failed for the inlined Inter Kit face",
    );
    assert.equal(
      probe.differ,
      true,
      "kit and serif probe widths match, so the text fell back",
    );
  });
});

test("captureCard rasterises a card to non-blank PNG bytes in WebKit", async () => {
  await withCapture(async (page) => {
    const out = await captureInPage(page, CARD_HTML, CARD_CSS);
    const png = Buffer.from(out.b64, "base64");

    assert.deepEqual(
      [...png.subarray(0, 8)],
      PNG_SIGNATURE,
      "result is not a PNG",
    );
    assert.ok(png.length > 1000, `PNG suspiciously small: ${png.length} bytes`);
    assert.deepEqual([out.width, out.height], [W, H]);
    assert.match(out.sha256, /^[0-9a-f]{64}$/);
    // The returned hash must be the hash of the returned bytes.
    assert.equal(out.sha256, createHash("sha256").update(png).digest("hex"));

    // The actual gate: PIXEL VARIANCE, not byte length. Blank measures ~0;
    // the spike measured 1151 on this exact ground/ink pair.
    assert.ok(
      out.pixelVariance > 100,
      `pixelVariance ${out.pixelVariance.toFixed(2)} is too low: blank or near-blank canvas`,
    );
  });
});

test("pixel variance discriminates what byte length cannot: a blank card still encodes a valid PNG", async () => {
  await withCapture(async (page) => {
    // Nothing paints: no background, no text. The result is a perfectly
    // valid PNG of a fully transparent canvas, which any byte-length or
    // signature check would accept.
    const out = await captureInPage(
      page,
      `<div class="card"></div>`,
      FONT_FACE,
    );
    const png = Buffer.from(out.b64, "base64");

    assert.deepEqual(
      [...png.subarray(0, 8)],
      PNG_SIGNATURE,
      "blank result is not even a PNG",
    );
    assert.ok(png.length > 0, "blank result has no bytes at all");
    assert.equal(out.sha256, createHash("sha256").update(png).digest("hex"));

    assert.ok(
      out.pixelVariance < 1,
      `blank canvas should report ~0 variance, got ${out.pixelVariance.toFixed(2)}; the variance gate cannot discriminate`,
    );
  });
});
