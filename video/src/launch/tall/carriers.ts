import { ownerSlot } from "../wide/beat.ts";
import type { Path } from "../wide/walk.ts";
import { yesCarryPath } from "../wide/yes.ts";

/**
 * A lead's carrier on the tall frame, in the film's panel pixels: in from
 * the left edge under the card, up the margin beside it, then into its row.
 * (The wide film's carriers climb from below the frame, which on the tall
 * frame is past the left edge.)
 */
export function tallCarryPath(i: number): Path {
  const end = ownerSlot(i);
  return [
    { x: 745 - i * 8, y: 1004 },
    { x: 826, y: 975 },
    { x: 818, y: end.y },
    end,
  ];
}

/** An inbox carrier on the tall frame: the film's walk, starting just past the left edge. */
export function tallYesCarryPath(i: number): Path {
  const [, turn, turnAgain, end] = yesCarryPath(i);
  return [{ x: 734 - i * 40, y: 880 + i * 4 }, turn, turnAgain, end];
}
