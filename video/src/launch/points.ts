export type Point = { x: number; y: number };

/**
 * Grid-samples the positions whose alpha is at least `threshold`.
 * `rgba` uses the ImageData layout: 4 bytes per pixel, alpha last.
 */
export function sampleAlphaPoints(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  step: number,
  threshold = 128,
): Point[] {
  const out: Point[] = [];
  const first = Math.floor(step / 2);
  for (let y = first; y < height; y += step) {
    for (let x = first; x < width; x += step) {
      if (rgba[(y * width + x) * 4 + 3] >= threshold) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Picks exactly `n` points from `pool` in a seeded shuffle order, cycling
 * the pool when it is smaller than `n`. Throws on an empty pool, because an
 * empty pool means nothing was drawn where we sampled.
 */
export function pickPoints(
  pool: Point[],
  n: number,
  rand: () => number,
): Point[] {
  if (pool.length === 0) {
    throw new Error("pickPoints: empty pool, nothing was drawn to sample");
  }
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) out.push(pool[order[i % order.length]]);
  return out;
}

/** The largest size up to `desired` whose measured width fits `maxWidth`. Width must scale linearly with size. */
export function fitFontSize(
  measureAtSize: (size: number) => number,
  desired: number,
  maxWidth: number,
): number {
  const width = measureAtSize(desired);
  return width <= maxWidth
    ? desired
    : Math.floor(desired * (maxWidth / width));
}
