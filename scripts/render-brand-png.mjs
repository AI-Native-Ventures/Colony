// Render an SVG file to PNG at an exact size using Playwright's Chromium.
// Usage: node scripts/render-brand-png.mjs in.svg out.png 1024 1024
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [svgPath, outPath, w, h] = process.argv.slice(2);
if (!svgPath || !outPath || !w || !h) {
  console.error("usage: render-brand-png.mjs <in.svg> <out.png> <w> <h>");
  process.exit(1);
}
const svg = readFileSync(resolve(svgPath), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<style>*{margin:0}svg{display:block;width:${w}px;height:${h}px}</style>${svg}`,
);
await page.screenshot({ path: resolve(outPath), omitBackground: true });
await browser.close();
console.log(outPath);
