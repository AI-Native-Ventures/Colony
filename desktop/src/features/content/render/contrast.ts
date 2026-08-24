/**
 * Mechanical WCAG contrast measurement for rendered cards.
 *
 * Ported from `colony-social-kit/tools/contrast.mjs`, which caught 8 cards
 * across 3 rounds of the launch build. The method is unchanged; only the
 * transport is, because that tool drove Playwright and this runs inside the
 * app's own webview.
 *
 * A scrim always looks heavier than it measures, so nothing here is judged by
 * eye. The measurement is taken against the pixels that actually rendered, not
 * against the colour a stylesheet claims sits behind the type:
 *
 *   1. Every text run to be checked carries `data-contrast="<label>"`.
 *   2. Those runs are hidden (visibility, not display, so layout is untouched)
 *      and the card is rasterised again. That second frame is the real
 *      background under the type: grounds, plates, marks and all.
 *   3. Every sampled pixel inside each run's border box is compared against
 *      that run's computed colour.
 *   4. The worst single pixel wins, because a box clearing 4.5:1 on average
 *      while failing over one pale mark leg is a fail.
 *
 * Sampling covers the whole border box, a superset of glyph coverage, so the
 * number is conservative by construction.
 *
 * **Grain, and why the worst pixel is measured twice.** Rule 4 was written for
 * grounds whose structure is a blurred gradient, where the worst pixel is a
 * fair proxy for its region. Grain breaks that: a speck is one to three pixels
 * wide and its neighbours are darker by as much as it is brighter, so scoring
 * the brightest speck measures a feature far smaller than a stroke. Legibility
 * follows the local mean. So the gate scores a low-passed plate, and the raw
 * worst pixel is reported alongside it rather than thrown away.
 */

import type { Rgb } from "./color";
import { contrastRatio, relativeLuminance } from "./color";

export { contrastRatio, relativeLuminance };
export type { Rgb };

/** The bar for body text. */
export const AA_BODY = 4.5;

/**
 * Gaussian radius, in px, applied to the plate before it is scored. Set to 0
 * to score raw pixels.
 */
export const GRAIN_BLUR = 2;

/** One text run to be measured, as read off the live card DOM. */
export type ContrastRun = {
  /** The `data-contrast` value, used to name the run in a failure. */
  label: string;
  /** Computed colour of the run, as `rgb()` or `rgba()`. */
  color: string;
  /**
   * Effective alpha: the colour's own alpha folded together with every
   * ancestor's opacity. `opacity: .85` on a parent leaves
   * `getComputedStyle().color` reporting the opaque value, so measuring the
   * colour alone reports a ratio the eye never gets.
   */
  alpha: number;
  /** Border box in CSS px. */
  box: { x: number; y: number; width: number; height: number };
};

/** What the gate reports for one run. */
export type ContrastMeasurement = {
  label: string;
  color: string;
  /** The gated figure: worst pixel against the low-passed plate. */
  ratio: number;
  /** The worst physical pixel, grain included. Reported, never gated on. */
  rawRatio: number;
  /** The background pixel that produced `ratio`, as `rgb(r, g, b)`. */
  worstBackground: string;
};

/** Pull the leading three channel numbers out of an `rgb()`/`rgba()` string. */
export function parseRgb(color: string): Rgb {
  const parts = color.match(/\d+(\.\d+)?/g);
  if (!parts || parts.length < 3) {
    throw new Error(`contrast: cannot read a colour out of "${color}"`);
  }
  const [r, g, b] = parts.slice(0, 3).map(Number);
  return [r, g, b];
}

/**
 * Read the runs to be measured off a live card subtree.
 *
 * Called before rasterising, because it needs layout: the boxes come from
 * `getBoundingClientRect`, and the colours from computed style.
 */
export function collectRuns(host: ParentNode): ContrastRun[] {
  const runs: ContrastRun[] = [];
  for (const node of Array.from(host.querySelectorAll("[data-contrast]"))) {
    const el = node as HTMLElement;
    const rect = el.getBoundingClientRect();
    let alpha = 1;
    for (
      let walk: HTMLElement | null = el;
      walk && walk !== document.documentElement;
      walk = walk.parentElement
    ) {
      const own = Number.parseFloat(getComputedStyle(walk).opacity);
      alpha *= Number.isNaN(own) ? 1 : own;
    }
    const color = getComputedStyle(el).color;
    const parts = color.match(/\d+(\.\d+)?/g);
    if (parts && parts.length > 3) {
      alpha *= Number(parts[3]);
    }
    runs.push({
      alpha,
      box: {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      },
      color,
      label: el.getAttribute("data-contrast") ?? "",
    });
  }
  return runs;
}

/**
 * Worst sampled pixel in one run's box, measured against one plate.
 *
 * Pure: takes pixels, returns numbers. Every intermediate is a plain JS number,
 * which is float64. Do NOT stage thresholds or luminances through a
 * `Float32Array`: a float32 threshold rejects its own pixels by 1 ulp when
 * compared against float64 per-pixel arithmetic, and the symptom is "no
 * readable pixels" while the box maximum is exactly the colour you are looking
 * for.
 */
export function worstInBox(
  pixels: Uint8ClampedArray,
  plateWidth: number,
  plateHeight: number,
  run: ContrastRun,
  scale: number,
  step: number,
): { ratio: number; background: Rgb } {
  const fg = parseRgb(run.color);
  const x0 = Math.max(0, Math.floor(run.box.x * scale));
  const y0 = Math.max(0, Math.floor(run.box.y * scale));
  const w = Math.min(plateWidth - x0, Math.ceil(run.box.width * scale));
  const h = Math.min(plateHeight - y0, Math.ceil(run.box.height * scale));
  if (w < 1 || h < 1) {
    throw new Error(`contrast: run "${run.label}" has an empty box`);
  }
  const stride = Math.max(1, Math.round(step * scale));

  let worst = Number.POSITIVE_INFINITY;
  let background: Rgb = [0, 0, 0];
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = ((y0 + y) * plateWidth + (x0 + x)) * 4;
      const bg: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
      // Translucent type is its own colour composited over whatever it sits
      // on, so the effective foreground is per-pixel too.
      const eff: Rgb =
        run.alpha === 1
          ? fg
          : (fg.map((c, k) => run.alpha * c + (1 - run.alpha) * bg[k]) as Rgb);
      const ratio = contrastRatio(eff, bg);
      if (ratio < worst) {
        worst = ratio;
        background = bg;
      }
    }
  }
  return { background, ratio: worst };
}

/**
 * Measure every run against a plate, gated on the low-passed copy and
 * reporting the raw worst pixel alongside.
 *
 * `soft` is the blurred plate and `raw` the unblurred one; pass the same
 * pixels for both to score raw.
 */
export function measureRuns(
  runs: ContrastRun[],
  soft: Uint8ClampedArray,
  raw: Uint8ClampedArray,
  plateWidth: number,
  plateHeight: number,
  { scale = 1, step = 2 }: { scale?: number; step?: number } = {},
): ContrastMeasurement[] {
  if (runs.length === 0) {
    throw new Error("contrast: no [data-contrast] runs on the card");
  }
  return runs.map((run) => {
    const gated = worstInBox(soft, plateWidth, plateHeight, run, scale, step);
    const unfiltered =
      soft === raw
        ? gated
        : worstInBox(raw, plateWidth, plateHeight, run, scale, step);
    return {
      color: run.color,
      label: run.label,
      ratio: Math.round(gated.ratio * 100) / 100,
      rawRatio: Math.round(unfiltered.ratio * 100) / 100,
      worstBackground: `rgb(${gated.background.join(", ")})`,
    };
  });
}

/** The worst run on a card, which is the figure the gate compares to the bar. */
export function worstRatio(measurements: ContrastMeasurement[]): number {
  return measurements.reduce(
    (worst, m) => Math.min(worst, m.ratio),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * The CSS that hides the measured runs for the plate pass. Appended to the
 * card's own stylesheet rather than mutating the DOM, so layout is identical
 * between the two frames.
 */
export const PLATE_CSS = "[data-contrast]{visibility:hidden}";
