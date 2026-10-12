import type { Lane } from "../launch/swarm.ts";
import { WIDE_H, WIDE_W } from "../launch/wide/beat.ts";
import type { Side } from "./swarmShape.ts";

/** Where an explainer's hook puts its words and builds its tool, on one frame. */
export type HookLayout = {
  w: number;
  h: number;
  /** The two big lines: left edge, top, largest size, and the width both must fit. */
  words: { x: number; top: number; size: number; width: number };
  /** The subline's size. */
  subline: number;
  /** Where the tool of ants is built. */
  shape: { cx: number; cy: number };
  lane: Lane;
  /** Edges the ants fly in from; `minX` and `minY` keep their starts clear of the words. */
  sides: readonly Side[];
  minX: number;
  minY: number;
};

/** The wide explainers' hook: the words on the left, the tool on the right. */
export const WIDE_HOOK: HookLayout = {
  w: WIDE_W,
  h: WIDE_H,
  words: { x: 140, top: 296, size: 116, width: WIDE_W - 280 },
  subline: 60,
  shape: { cx: 1350, cy: 560 },
  lane: { c1: { x: 1620, y: 260 }, c2: { x: 1180, y: 820 }, spread: 260 },
  sides: ["top", "right", "bottom"],
  minX: 1000,
  minY: 0,
};
