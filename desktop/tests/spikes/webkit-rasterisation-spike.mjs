// Throwaway spike: can a card be rasterised to a PNG inside WebKit?
//
// Colony's desktop app is Tauri, whose webview is WKWebView on macOS and
// WebKit2GTK on Linux. The planned capture path is SVG foreignObject drawn to
// a canvas, which is reliable in Chromium and historically flaky in WebKit.
// This prints numbers; it does not assert a verdict.
//
//   node webkit-spike.mjs [chromium]
//
// Pass "chromium" to run the same spike in Chromium as a control, so a WebKit
// failure can be told apart from a bug in the spike itself.

import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";

const ENGINE = process.argv[2] === "chromium" ? chromium : webkit;
const ENGINE_NAME = process.argv[2] === "chromium" ? "chromium" : "webkit";

const FONT = readFileSync(
  "/Users/mac/.buzz/REPOS/colony-social-kit/brand/fonts/InterVariable.ttf",
).toString("base64");

const W = 1080;
const H = 1350;

// Ground and ink chosen so the expected contrast is knowable up front.
const GROUND = "#3b1f6e";
const INK = "#ffffff";

const page_html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face{font-family:"Inter Kit";src:url(data:font/ttf;base64,${FONT}) format("truetype");font-weight:100 900;font-display:block}
  html,body{margin:0;padding:0;background:#000}
  #host{width:${W}px;height:${H}px}
  .card{width:${W}px;height:${H}px;background:${GROUND};display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:96px}
  .headline{font-family:"Inter Kit";font-weight:600;font-size:96px;line-height:1.05;color:${INK};letter-spacing:-0.02em}
  .probe{font-size:100px;position:absolute;left:-9999px;top:-9999px;white-space:nowrap}
  .probe-kit{font-family:"Inter Kit"}
  .probe-sys{font-family:"Times New Roman",serif}
</style></head>
<body>
  <div id="host"></div>
  <span id="pk" class="probe probe-kit">Run your company with AI agents.</span>
  <span id="ps" class="probe probe-sys">Run your company with AI agents.</span>
  <canvas id="cv" width="${W}" height="${H}"></canvas>
</body></html>`;

const browser = await ENGINE.launch();
const page = await browser.newPage({ viewport: { width: W, height: 700 } });
await page.setContent(page_html, { waitUntil: "load" });

const result = await page.evaluate(
  async ({ W, H, GROUND, INK }) => {
    const out = {};

    // --- 1. did the inlined font actually load and render? -------------
    await document.fonts.ready;
    out.fontsCheck = document.fonts.check('96px "Inter Kit"');
    const wKit = document.getElementById("pk").getBoundingClientRect().width;
    const wSys = document.getElementById("ps").getBoundingClientRect().width;
    out.probeKitWidth = Math.round(wKit * 100) / 100;
    out.probeSysWidth = Math.round(wSys * 100) / 100;
    out.widthsDiffer = Math.abs(wKit - wSys) > 1;

    // --- 2. rasterise the card via foreignObject ------------------------
    const card = `<div xmlns="http://www.w3.org/1999/xhtml" class="card"><div class="headline">Run your company with AI agents.</div></div>`;
    const sheet = Array.from(document.styleSheets[0].cssRules)
      .map((r) => r.cssText)
      .join("\n");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
      `<defs><style type="text/css"><![CDATA[${sheet}]]></style></defs>` +
      `<foreignObject width="${W}" height="${H}">${card}</foreignObject></svg>`;

    // A blob: URL taints the canvas in BOTH engines, so getImageData throws
    // and the gates can never read a pixel. A same-document data: URI does
    // not. This distinction is the whole ballgame for pixel gates.
    const blobUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = new Image();
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = blobUrl;
      setTimeout(() => resolve(false), 8000);
    });
    out.svgImageLoaded = loaded;

    const cv = document.getElementById("cv");
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    let drawThrew = null;
    try {
      ctx.drawImage(img, 0, 0, W, H);
    } catch (e) {
      drawThrew = String(e && e.message ? e.message : e);
    }
    out.drawThrew = drawThrew;

    // --- 3. pixel variance: a blank canvas still encodes a valid PNG ----
    let data;
    try {
      data = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      out.getImageDataThrew = String(e && e.message ? e.message : e);
      return out;
    }
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4 * 37) {
      const lum =
        0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      n++;
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const mean = sum / n;
    out.pixelVariance = Math.round((sumSq / n - mean * mean) * 100) / 100;
    out.distinctColoursSampled = counts.size;
    out.meanLuminance = Math.round(mean * 100) / 100;

    // --- 4. measured contrast between the two dominant colours ---------
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
    out.topColours = top.map(([k, v]) => ({
      rgb: k,
      share: Math.round((v / n) * 1000) / 10,
    }));
    const rel = (rgb) => {
      const [r, g, b] = rgb
        .split(",")
        .map(Number)
        .map((c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    if (top.length === 2) {
      const l1 = rel(top[0][0]);
      const l2 = rel(top[1][0]);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      out.measuredContrast = Math.round(ratio * 100) / 100;
    }
    return out;
  },
  { W, H, GROUND, INK },
);

// Expected contrast for the chosen pair, computed outside the page as a check
// on the in-page measurement rather than a substitute for it.
const rel = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [16, 8, 0]
    .map((s) => ((n >> s) & 255) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
};
const expected =
  (Math.max(rel(INK), rel(GROUND)) + 0.05) /
  (Math.min(rel(INK), rel(GROUND)) + 0.05);

console.log(`engine: ${ENGINE_NAME}`);
console.log(
  `expected contrast for ${INK} on ${GROUND}: ${Math.round(expected * 100) / 100}:1`,
);
console.log(JSON.stringify(result, null, 2));

await browser.close();
