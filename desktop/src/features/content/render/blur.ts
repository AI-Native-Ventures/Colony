/**
 * The low-pass the contrast gate scores against.
 *
 * `contrast.ts` gates on the worst pixel of a *blurred* plate and reports the
 * raw worst pixel alongside, because a grain tile puts single pixels several
 * shades off the ground it belongs to. Scoring those directly makes a card's
 * verdict depend on where a noise grain happened to land, which is not the
 * thing the eye reads. The plate is low-passed first; `GRAIN_BLUR` is the
 * radius, and this module is what applies it.
 *
 * A box blur run three times approximates a Gaussian closely enough for a
 * threshold comparison, and unlike a canvas `filter` it is pure, deterministic
 * and runs in node, so the gate's maths stays testable without a browser.
 *
 * Every intermediate is a plain JS number, which is float64. Do NOT stage the
 * accumulator through a `Float32Array`: the same 1-ulp trap documented in
 * `contrast.ts` and `grain.ts` applies to anything a threshold later meets.
 */

/** How many box passes approximate the Gaussian. Three is the standard. */
const PASSES = 3;

/**
 * One separable box-blur pass over a single channel plane.
 *
 * Edges clamp rather than wrap: a wrapped sample would carry the opposite
 * edge's colour into a corner, and a corner is exactly where a card's ground
 * is darkest.
 */
function boxPass(
  src: Float64Array,
  dst: Float64Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;
  const window = radius * 2 + 1;
  for (let o = 0; o < outer; o++) {
    const base = horizontal ? o * width : o;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[base + Math.min(inner - 1, Math.max(0, k)) * step];
    }
    for (let i = 0; i < inner; i++) {
      dst[base + i * step] = sum / window;
      const leaving = Math.min(inner - 1, Math.max(0, i - radius));
      const entering = Math.min(inner - 1, Math.max(0, i + radius + 1));
      sum += src[base + entering * step] - src[base + leaving * step];
    }
  }
}

/**
 * `pixels` low-passed at `radius`, as a new RGBA buffer.
 *
 * Alpha is carried through untouched: the capture path clears its canvas
 * before drawing, so a card's own ground is opaque everywhere and blurring
 * alpha would only soften the frame's outer edge into transparency.
 *
 * A radius of 0 returns a copy, so a caller can pass the gate's constant
 * through without branching on it.
 */
export function boxBlurRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error(`blur: bad frame size ${width}x${height}`);
  }
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `blur: ${pixels.length} bytes is not a ${width}x${height} RGBA frame`,
    );
  }
  const out = new Uint8ClampedArray(pixels);
  if (radius <= 0) {
    return out;
  }
  const n = width * height;
  const plane = new Float64Array(n);
  const scratch = new Float64Array(n);
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < n; i++) {
      plane[i] = pixels[i * 4 + channel];
    }
    for (let pass = 0; pass < PASSES; pass++) {
      boxPass(plane, scratch, width, height, radius, true);
      boxPass(scratch, plane, width, height, radius, false);
    }
    for (let i = 0; i < n; i++) {
      out[i * 4 + channel] = Math.round(plane[i]);
    }
  }
  return out;
}
