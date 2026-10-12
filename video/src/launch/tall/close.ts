import type { CloseLayout } from "../wide/closeLayout.ts";
import type { CloseSwarmOptions } from "../wide/closeSwarm.ts";
import { DAY_END } from "../wide/day.ts";
import { tallDayAntSpot } from "./day.ts";
import { TALL_H, TALL_W } from "./frame.ts";

/** The close on the tall frame: the logo and the words above the captions, in the middle of the view. */
export const TALL_CLOSE: CloseLayout = {
  w: TALL_W,
  h: TALL_H,
  logo: { cx: 540, cy: 620, width: 380, height: 380 * (309 / 466) },
  name: 150,
  tagline: 46,
};

/** The four ants leave the end of the day down the page, rise up the right and curl over into their part of the logo. */
export const TALL_CLOSE_SWARM: CloseSwarmOptions = {
  home: (k) => tallDayAntSpot(k, DAY_END),
  lanes: {
    blue: { c1: { x: 860, y: 1000 }, c2: { x: 260, y: 380 }, spread: 100 },
    amber: { c1: { x: 900, y: 940 }, c2: { x: 420, y: 360 }, spread: 100 },
    pink: { c1: { x: 940, y: 880 }, c2: { x: 760, y: 360 }, spread: 100 },
    green: { c1: { x: 980, y: 820 }, c2: { x: 600, y: 360 }, spread: 100 },
  },
  frameWidth: TALL_W,
};
