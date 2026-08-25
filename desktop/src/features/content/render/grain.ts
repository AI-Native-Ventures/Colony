/**
 * How grainy a rendered card actually is, so "add more grain" is a number
 * rather than a taste argument.
 *
 * Ported from `colony-social-kit/tools/grain.mjs`, which turned the launch
 * review note — "look at how their background is, ours is too solid, there is
 * more grainy" — into something measurable. Both halves of that note are.
 *
 * Two figures, each taken over the whole frame and over its flattest quarter:
 *
 *   grain  RMS of each pixel's luminance minus the mean of its 3x3
 *          neighbourhood, in 0-255 units. High-frequency energy: a perfectly
 *          smooth gradient scores near 0 no matter how strong the gradient,
 *          because a gradient is low-frequency. Film grain and sensor noise
 *          score high.
 *   band   the mean absolute luminance step to the neighbouring pixel. A
 *          smooth gradient rendered in 8 bits shows up here as visible
 *          banding while scoring nothing on grain.
 *
 * The flattest quarter matters because it is the tile with no type and no
 * subject in it, which is the honest read on the ground itself.
 *
 * The source measured decoded PNGs through Playwright. This takes the pixels
 * the capture path already produced, so nothing is re-encoded or re-decoded
 * between rendering a card and scoring it.
 */

/** Grain figures for one frame. */
export type GrainReport = {
  /** `${width}x${height}`, so a report names what it measured. */
  size: string;
  /** High-frequency energy over the whole frame, 0-255 units. */
  grain: number;
  /** Mean neighbouring-pixel luminance step over the whole frame. */
  band: number;
  /** Grain over the flattest quarter: the ground, without type or subject. */
  quietGrain: number;
  /** Band over the flattest quarter. */
  quietBand: number;
  /** Where the quiet figures were taken, as `[x0, y0, x1, y1]`. */
  quietBox: [number, number, number, number];
};

/** The kit's acceptable range for a ground's quiet grain. */
export type GrainRange = { min: number; max: number };

/**
 * Per-pixel luminance for a frame.
 *
 * `Float64Array`, deliberately. The upstream tool used `Float32Array` here and
 * got away with it because it only ever compared these values to each other.
 * Anything that later compares one of these against a threshold computed in
 * ordinary JS arithmetic — which is float64 — can be wrong by 1 ulp, and that
 * presents as "no readable pixels" while the extreme is exactly the value
 * being looked for. Keeping the whole pipeline at float64 removes the class.
 */
export function luminancePlane(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Float64Array {
  const lum = new Float64Array(width * height);
  for (let i = 0, p = 0; p < width * height; i += 4, p++) {
    lum[p] =
      0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  }
  return lum;
}

/**
 * Grain and band over one rectangle of a luminance plane.
 *
 * Edge pixels are skipped: a 3x3 neighbourhood needs one pixel of margin, and
 * inventing values outside the frame would score the invention.
 */
export function measureRegion(
  lum: Float64Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { grain: number; band: number; pixels: number } {
  let sq = 0;
  let step = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y < Math.min(height - 1, y1); y++) {
    for (let x = Math.max(1, x0); x < Math.min(width - 1, x1); x++) {
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          mean += lum[(y + dy) * width + (x + dx)];
        }
      }
      mean /= 9;
      const d = lum[y * width + x] - mean;
      sq += d * d;
      step += Math.abs(lum[y * width + x] - lum[y * width + x + 1]);
      n++;
    }
  }
  if (n === 0) {
    throw new Error("grain: region has no measurable interior");
  }
  return { band: step / n, grain: Math.sqrt(sq / n), pixels: n };
}

/**
 * The flattest tile of a 4x4 grid, scored on luminance spread.
 *
 * That tile is the one with no type and no subject in it. Scoring the ground
 * there rather than over the whole frame is what stops a headline's edges
 * counting as texture.
 */
export function flattestTile(
  lum: Float64Array,
  width: number,
  height: number,
): [number, number, number, number] {
  let best: { box: [number, number, number, number]; spread: number } | null =
    null;
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const x0 = Math.floor((tx * width) / 4);
      const y0 = Math.floor((ty * height) / 4);
      const x1 = Math.floor(((tx + 1) * width) / 4);
      const y1 = Math.floor(((ty + 1) * height) / 4);
      let min = 255;
      let max = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const v = lum[y * width + x];
          if (v < min) {
            min = v;
          }
          if (v > max) {
            max = v;
          }
        }
      }
      const spread = max - min;
      if (!best || spread < best.spread) {
        best = { box: [x0, y0, x1, y1], spread };
      }
    }
  }
  if (!best) {
    throw new Error("grain: frame too small to tile");
  }
  return best.box;
}

/** Measure a frame the capture path already produced. */
export function measureGrain(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): GrainReport {
  const lum = luminancePlane(pixels, width, height);
  const whole = measureRegion(lum, width, height, 0, 0, width, height);
  const quietBox = flattestTile(lum, width, height);
  const quiet = measureRegion(lum, width, height, ...quietBox);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    band: round(whole.band),
    grain: round(whole.grain),
    quietBand: round(quiet.band),
    quietBox,
    quietGrain: round(quiet.grain),
    size: `${width}x${height}`,
  };
}

/**
 * Whether a frame's ground sits inside the kit's grain range.
 *
 * Gated on `quietGrain`, not `grain`: the whole-frame figure rises with the
 * amount of type on a card, so gating on it would make a wordy card look
 * grainier than a sparse one rendered from the same ground.
 */
export function grainWithin(
  report: GrainReport,
  range: GrainRange,
): { pass: boolean; measured: number; reason?: string } {
  const measured = report.quietGrain;
  if (measured < range.min) {
    return {
      measured,
      pass: false,
      reason: `ground is too solid: quiet grain ${measured} is under the kit floor of ${range.min}`,
    };
  }
  if (measured > range.max) {
    return {
      measured,
      pass: false,
      reason: `ground is too noisy: quiet grain ${measured} is over the kit ceiling of ${range.max}`,
    };
  }
  return { measured, pass: true };
}
