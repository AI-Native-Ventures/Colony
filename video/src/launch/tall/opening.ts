import type { OpeningLayout } from "../wide/intro.ts";
import { TALL_H, TALL_W } from "./frame.ts";

/**
 * The opening on a phone held upright: the trades and the pile of jobs in
 * the middle, the logo a little above it, the definition under the logo,
 * and the ants flying out past the sides and the bottom before they build
 * the logo.
 */
export const TALL_OPENING: OpeningLayout = {
  w: TALL_W,
  h: TALL_H,
  trade: { top: 860, size: 128 },
  tower: { centerY: 960, maxWidth: 940 },
  logo: { cx: 540, cy: 760, width: 380, height: 380 * (309 / 466) },
  logoShift: -230,
  define: { top: 660, width: 900 },
  team: { y: 1300, gap: 120 },
  lanes: [
    { c1: { x: -300, y: 1500 }, c2: { x: -100, y: 300 }, spread: 120 },
    { c1: { x: 200, y: 2250 }, c2: { x: -250, y: 900 }, spread: 130 },
    { c1: { x: 880, y: 2250 }, c2: { x: 1330, y: 900 }, spread: 130 },
    { c1: { x: 1380, y: 1500 }, c2: { x: 1180, y: 300 }, spread: 120 },
  ],
};
