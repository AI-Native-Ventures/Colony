/**
 * One card, from spec to measured slide.
 *
 * This is the join the render port was missing: templates, capture and the
 * three pixel gates all existed and were tested, but nothing walked a card
 * through them, so none of it ran in the app.
 *
 * The card is rasterised **three times**, and each frame answers one question
 * the others cannot:
 *
 * | frame | stylesheet | answers |
 * | --- | --- | --- |
 * | card | the kit face | the bytes that ship, and the ground's grain |
 * | plate | face + `PLATE_CSS` | what colour sits *under* each run |
 * | control | no face at all | did the kit face reach the raster |
 *
 * The plate matters because contrast is a question about a run against the
 * pixels behind it, and those pixels are hidden by the run itself in the
 * frame that ships. `PLATE_CSS` hides the runs with `visibility` rather than
 * removing them, so layout is identical between the two frames and a box
 * measured on one names the right pixels on the other.
 *
 * **Layout is measured in an isolated document.** The card stylesheet resets
 * `*` and sizes `html, body`; mounting it in the app's own document would
 * apply that to the app. The card gets an offscreen iframe, which also gives
 * `getBoundingClientRect` an origin at the top-left of the canvas rather than
 * wherever the app happened to scroll to.
 */

import { boxBlurRgba } from "./blur";
import { captureCard } from "./capture";
import type { CardSpec } from "./compositions";
import type { BrandKit } from "./kit";
import type { CardMark } from "./marks";
import { CANVAS_H, CANVAS_W, cardHtml } from "./compositions";
import { collectRuns, GRAIN_BLUR, measureRuns, PLATE_CSS } from "./contrast";
import type { ContrastRun } from "./contrast";
import type { Box } from "./fontGate";
import { fontReachedRaster, stripFontFaces } from "./fontGate";
import { measureGrain } from "./grain";
import type { RenderedSlide } from "./pipeline";

/** How long a card gets to lay out and load its face before it is refused. */
const LAYOUT_TIMEOUT_MS = 8000;

/** What a rendered slide brings back, plus the bytes for the upload. */
export type SlideCapture = RenderedSlide & {
  /** Sampled luminance variance of the shipped frame; near zero is blank. */
  pixelVariance: number;
};

export type RenderSlideOptions = {
  /** The `@font-face` rule for the kit face, from `fontKit.ts`. */
  fontFaceCss: string;
  /** The workspace's brand kit. Colony's own when absent. */
  kit?: BrandKit;
  /** The kit-resolved mark the card closes with; ant when absent. */
  mark?: CardMark;
  width?: number;
  height?: number;
};

/**
 * The box the font gate diffs.
 *
 * The union of every measured run, which is exactly the type on the card: a
 * fixed guess at "where the headline is" would move with the layout, and a
 * whole-frame diff would drown a 20-unit type delta in an identical ground.
 */
export function textBox(
  runs: ContrastRun[],
  width: number,
  height: number,
): Box {
  if (runs.length === 0) {
    throw new Error("render: the card has no [data-contrast] runs to measure");
  }
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    x0 = Math.min(x0, run.box.x);
    y0 = Math.min(y0, run.box.y);
    x1 = Math.max(x1, run.box.x + run.box.width);
    y1 = Math.max(y1, run.box.y + run.box.height);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new Error("render: every text run laid out off the canvas");
  }
  return { height: y1 - y0, width: x1 - x0, x: x0, y: y0 };
}

function mountCard(
  html: string,
  fontFaceCss: string,
  width: number,
  height: number,
): Promise<{ document: Document; window: Window; dispose: () => void }> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    // Laid out, so boxes are real, but never seen and never interactive.
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.style.cssText =
      `position:fixed;left:0;top:0;width:${width}px;height:${height}px;` +
      `border:0;visibility:hidden;pointer-events:none;z-index:-1`;
    const dispose = () => frame.remove();
    const timer = setTimeout(() => {
      dispose();
      reject(
        new Error(
          `render: the card did not lay out within ${LAYOUT_TIMEOUT_MS}ms`,
        ),
      );
    }, LAYOUT_TIMEOUT_MS);
    frame.onload = () => {
      clearTimeout(timer);
      const doc = frame.contentDocument;
      const win = frame.contentWindow;
      if (!doc || !win) {
        dispose();
        reject(new Error("render: the layout frame has no document"));
        return;
      }
      // The face must be settled before boxes are read: an unloaded face lays
      // out in a fallback and every box would name the wrong pixels.
      doc.fonts.ready.then(
        () => resolve({ dispose, document: doc, window: win }),
        (error: unknown) => {
          dispose();
          reject(new Error(`render: the kit face did not settle (${error})`));
        },
      );
    };
    frame.srcdoc = `<!doctype html><html><head><style>${fontFaceCss}</style></head>${html}</html>`;
    document.body.append(frame);
  });
}

/**
 * Rasterise one card and measure it.
 *
 * Nothing here decides whether the card is good: it returns the measurements,
 * and `pipeline.ts` turns them into gate entries and a report bound to the
 * bytes.
 */
export async function renderSlide(
  card: CardSpec,
  {
    fontFaceCss,
    kit,
    mark,
    width = CANVAS_W,
    height = CANVAS_H,
  }: RenderSlideOptions,
): Promise<SlideCapture> {
  // The face is supplied through the capture stylesheet rather than baked into
  // the markup, because the control frame is the same markup with no face at
  // all, and the two must differ in nothing else.
  const html = cardHtml(card, { fontFaceCss: "", kit, mark });

  const mounted = await mountCard(html, fontFaceCss, width, height);
  let runs: ContrastRun[];
  try {
    runs = collectRuns(mounted.document.body, mounted.window);
  } finally {
    mounted.dispose();
  }
  if (runs.length === 0) {
    throw new Error(`${card.slug}: the card has no [data-contrast] runs`);
  }

  const shipped = await captureCard(html, fontFaceCss, width, height);
  const plate = await captureCard(
    html,
    `${fontFaceCss}${PLATE_CSS}`,
    width,
    height,
  );
  const control = await captureCard(stripFontFaces(html), "", width, height);

  return {
    contrast: measureRuns(
      runs,
      boxBlurRgba(plate.pixels, width, height, GRAIN_BLUR),
      plate.pixels,
      width,
      height,
    ),
    font: fontReachedRaster(
      shipped.pixels,
      control.pixels,
      width,
      height,
      textBox(runs, width, height),
    ),
    grain: measureGrain(shipped.pixels, width, height),
    height,
    pixelVariance: shipped.pixelVariance,
    png: shipped.png,
    sha256: shipped.sha256,
    width,
  };
}
