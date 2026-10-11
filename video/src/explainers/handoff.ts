import { easeInOutCubic, progress } from "../launch/math.ts";
import { BOARD, rowY } from "../launch/wide/beat.ts";
import type { Rect } from "./approve.ts";

/** The sales employee's card, under its hero: the owner's picks slide in, and its Approve waits. */
export const HANDOFF_CARD: Rect = { x: 140, y: 770, w: 620, h: 140 };
export const HANDOFF_APPROVE: Rect = {
  x: HANDOFF_CARD.x + HANDOFF_CARD.w - 28 - 190,
  y: HANDOFF_CARD.y + 40,
  w: 190,
  h: 60,
};
/** A picked lead, as a small round chip with its initial. */
export const CHIP = 44;

export type HandoffTiming = {
  chipFrom: number;
  chipEvery: number;
  chipFlight: number;
};

/** Centre of pick `k`'s place in the card. */
export function slotSpot(k: number): { x: number; y: number } {
  return {
    x: HANDOFF_CARD.x + 28 + CHIP / 2 + k * (CHIP + 8),
    y: HANDOFF_CARD.y + 76 + CHIP / 2,
  };
}

/** Where a picked row's chip lifts off: over the start of the company name. */
export function chipStart(row: number): { x: number; y: number } {
  return { x: BOARD.x + 140, y: rowY(row) + 38 };
}

export function chipLeaves(k: number, timing: HandoffTiming): number {
  return timing.chipFrom + k * timing.chipEvery;
}

export function chipLands(k: number, timing: HandoffTiming): number {
  return chipLeaves(k, timing) + timing.chipFlight;
}

/** Pick `k` (row `row`) at `t`: down beside the board, then a slide left into its place. */
export function chipAt(
  k: number,
  row: number,
  t: number,
  timing: HandoffTiming,
): { x: number; y: number } {
  const a = chipStart(row);
  const b = slotSpot(k);
  const c = { x: a.x - 120, y: b.y + 10 };
  const e = easeInOutCubic(
    progress(t, chipLeaves(k, timing), timing.chipFlight),
  );
  const u = 1 - e;
  return {
    x: u * u * a.x + 2 * u * e * c.x + e * e * b.x,
    y: u * u * a.y + 2 * u * e * c.y + e * e * b.y,
  };
}
