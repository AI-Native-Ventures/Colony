import { easeInOutCubic, progress } from "./math.ts";

export type StackOptions = {
  centerY: number;
  /** Line gap as a fraction of the two neighbouring font sizes. */
  leading: number;
  /** Seconds the tower takes to open the gap for a landing word. */
  pushSeconds: number;
};

/**
 * Vertical centres for a growing tower of words. Each word lands at the
 * bottom at its `at` time; as it lands the gap above it opens smoothly and
 * the whole tower re-centres on `centerY`. Returns a slot for every word,
 * landed or not, so callers can animate a word into its slot.
 */
export function stackY(
  sizes: number[],
  ats: number[],
  t: number,
  opts: StackOptions,
): number[] {
  const open = sizes.map((size, j) =>
    j === 0
      ? 0
      : ((sizes[j - 1] + size) / 2) *
        opts.leading *
        easeInOutCubic(progress(t, ats[j], opts.pushSeconds)),
  );
  const height = open.reduce((sum, gap) => sum + gap, 0);
  const ys: number[] = [];
  let y = opts.centerY - height / 2;
  for (const gap of open) {
    y += gap;
    ys.push(y);
  }
  return ys;
}
