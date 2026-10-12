import type { Box } from "../launch/tall/frame.ts";
import { TALL_H, TALL_W } from "../launch/tall/frame.ts";
import type { HookLayout } from "./hookLayout.ts";

/** The hook on the Reels frame: the words on top, the tool built under them, the ants in from the sides and the bottom. */
export const TALL_HOOK: HookLayout = {
  w: TALL_W,
  h: TALL_H,
  words: { x: 58, top: 300, size: 116, width: 964 },
  subline: 60,
  shape: { cx: 540, cy: 1010 },
  lane: { c1: { x: 960, y: 1560 }, c2: { x: 160, y: 1240 }, spread: 220 },
  sides: ["right", "bottom", "left"],
  minX: 0,
  minY: 700,
};

/**
 * The words' size: the largest, at most `words.size`, at which both lines
 * fit `words.width`, estimated at 0.56 em a character (the scene measures
 * the real width).
 */
export function hookWordSize(
  lines: readonly [string, string],
  layout: HookLayout,
): number {
  const longest = Math.max(...lines.map((l) => l.length));
  const width = longest * 0.56 * layout.words.size;
  return width <= layout.words.width
    ? layout.words.size
    : Math.floor(layout.words.size * (layout.words.width / width));
}

/** The words block: the two lines at their size and the subline under them. */
export function hookWordsBox(
  lines: readonly [string, string],
  layout: HookLayout,
): Box {
  const size = hookWordSize(lines, layout);
  return {
    x: layout.words.x,
    y: layout.words.top,
    w: layout.words.width,
    h: 2 * 1.02 * size + 30 + layout.subline * 1.21,
  };
}
