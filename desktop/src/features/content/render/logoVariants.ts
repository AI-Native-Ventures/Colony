/**
 * Deriving the versions of a logo the cards need, as pure pixel work.
 *
 * A logo handed over once has to live on every ground a card can have, and
 * plastering the original everywhere is how a dark wordmark ends up invisible
 * on a night card. So from one image this module derives what a designer
 * would: the original with its flat background lifted off, a white version
 * for dark grounds, and an ink version for light ones.
 *
 * Everything here works on raw RGBA arrays so it tests in node; decoding and
 * encoding PNGs needs a canvas and lives in `marksRuntime.ts`.
 */

/** Alpha below which a pixel counts as already transparent. */
const TRANSPARENT_ALPHA = 8;

/**
 * Whether the image already carries real transparency.
 *
 * One transparent pixel is not "has transparency": JPEG-to-PNG conversions
 * leave stray corners. The bar is 2% of pixels, past which the author
 * plainly meant the background to be open and removal must not run again.
 */
export function hasTransparency(data: Uint8ClampedArray): boolean {
  const pixels = data.length / 4;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] <= TRANSPARENT_ALPHA) {
      transparent += 1;
    }
  }
  return transparent > pixels * 0.02;
}

function distanceSq(
  data: Uint8ClampedArray,
  offset: number,
  [r, g, b]: [number, number, number],
): number {
  const dr = data[offset] - r;
  const dg = data[offset + 1] - g;
  const db = data[offset + 2] - b;
  return dr * dr + dg * dg + db * db;
}

/**
 * The flat background colour the border agrees on, or null when it doesn't.
 *
 * Sampled along all four edges rather than the four corners alone: a logo
 * that touches one edge still yields a background from the other pixels,
 * while a photograph disagrees with itself immediately and returns null,
 * which is the signal to leave the image alone.
 */
export function borderBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 18,
): [number, number, number] | null {
  const offsets: number[] = [];
  for (let x = 0; x < width; x += 1) {
    offsets.push(x * 4, (width * (height - 1) + x) * 4);
  }
  for (let y = 1; y < height - 1; y += 1) {
    offsets.push(y * width * 4, (y * width + width - 1) * 4);
  }
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let counted = 0;
  for (const offset of offsets) {
    if (data[offset + 3] <= TRANSPARENT_ALPHA) {
      continue;
    }
    sr += data[offset];
    sg += data[offset + 1];
    sb += data[offset + 2];
    counted += 1;
  }
  if (counted < offsets.length * 0.9) {
    // The border is already mostly transparent; nothing to detect.
    return null;
  }
  const mean: [number, number, number] = [
    Math.round(sr / counted),
    Math.round(sg / counted),
    Math.round(sb / counted),
  ];
  const limit = tolerance * tolerance;
  let agreeing = 0;
  for (const offset of offsets) {
    if (
      data[offset + 3] > TRANSPARENT_ALPHA &&
      distanceSq(data, offset, mean) <= limit
    ) {
      agreeing += 1;
    }
  }
  // 95%: a border with a logo crossing it still resolves, one with a second
  // colour band does not.
  return agreeing >= counted * 0.95 ? mean : null;
}

/**
 * Lift a flat background off the image.
 *
 * Flood fill from the border, never a global colour match: a white
 * background disappears while the white counters inside a letterform stay,
 * because they are not connected to the edge.
 */
export function removeBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: [number, number, number],
  tolerance = 40,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data);
  const limit = tolerance * tolerance;
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const index = y * width + x;
    if (visited[index]) {
      return;
    }
    visited[index] = 1;
    const offset = index * 4;
    if (
      out[offset + 3] > TRANSPARENT_ALPHA &&
      distanceSq(out, offset, background) > limit
    ) {
      return;
    }
    out[offset + 3] = 0;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  while (queue.length > 0) {
    const index = queue.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) {
      push(x - 1, y);
    }
    if (x < width - 1) {
      push(x + 1, y);
    }
    if (y > 0) {
      push(x, y - 1);
    }
    if (y < height - 1) {
      push(x, y + 1);
    }
  }
  return out;
}

/**
 * The one-colour version: every visible pixel takes the given colour, alpha
 * stays. This is deliberately blunt; a multi-colour logo's on-dark version
 * is its shape in white, which is what a designer's mono lockup is.
 */
export function silhouette(
  data: Uint8ClampedArray,
  [r, g, b]: [number, number, number],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data);
  for (let offset = 0; offset < out.length; offset += 4) {
    if (out[offset + 3] > TRANSPARENT_ALPHA) {
      out[offset] = r;
      out[offset + 1] = g;
      out[offset + 2] = b;
    }
  }
  return out;
}
