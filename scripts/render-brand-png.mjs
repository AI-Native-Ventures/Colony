// Render an SVG file to PNG at an exact size using Playwright's Chromium.
// Usage: node scripts/render-brand-png.mjs in.svg out.png 1024 1024
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [svgPath, outPath, widthArg, heightArg] = process.argv.slice(2);
if (!svgPath || !outPath || !widthArg || !heightArg) {
  console.error("usage: render-brand-png.mjs <in.svg> <out.png> <w> <h>");
  process.exit(1);
}

const resolvedSvgPath = resolve(svgPath);
if (!existsSync(resolvedSvgPath)) {
  console.error(`input SVG not found: ${resolvedSvgPath}`);
  process.exit(1);
}

const w = Number(widthArg);
const h = Number(heightArg);
if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
  console.error(
    `width and height must be positive numbers, got: ${widthArg} ${heightArg}`,
  );
  process.exit(1);
}

const svg = readFileSync(resolvedSvgPath, "utf8");
const outFile = resolve(outPath);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>*{margin:0}svg{display:block;width:${w}px;height:${h}px}</style>${svg}`,
  );
  await page.screenshot({ path: outFile, omitBackground: true });
} finally {
  await browser.close();
}
console.log(outFile);
