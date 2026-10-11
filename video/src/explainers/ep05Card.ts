import type { CursorKey } from "../launch/app/cursorPath.ts";
import { POSTS_CARD } from "../launch/wide/posts.ts";

/** The pink button that takes the "3 ready" chip's place at the yes beat, in panel pixels. */
export const APPROVE_BUTTON = {
  x: POSTS_CARD.x + POSTS_CARD.w - 48 - 372,
  y: POSTS_CARD.y + 48,
  w: 372,
  h: 68,
};

/** The owner's pointer: in from the lower right, onto Approve, a short rest after the click. */
export function approveCursorKeys(timing: {
  cursorFrom: number;
  click: number;
}): CursorKey[] {
  const x = APPROVE_BUTTON.x + APPROVE_BUTTON.w * 0.56;
  const y = APPROVE_BUTTON.y + APPROVE_BUTTON.h * 0.58;
  return [
    { at: timing.cursorFrom, x: 1730, y: 880 },
    { at: timing.click - 0.15, x, y },
    { at: timing.click + 0.7, x: x + 10, y: y + 8 },
  ];
}
