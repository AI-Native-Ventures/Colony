import type { CursorKey } from "../launch/app/cursorPath.ts";
import type { Box } from "../launch/tall/frame.ts";

/**
 * The phone-style card every upright explainer draws its work in: centred,
 * under the slim header, above the big captions, left of Instagram's
 * buttons (owner, 2026-10-12: "Whole card = phone screen").
 */
export const PHONE_CARD: Box = { x: 140, y: 376, w: 800, h: 924 };

/** Space inside the card's edges. */
export const PHONE_PAD = 44;

/** The button pinned to the card's foot (Approve and the like), frame pixels. */
export const PINNED: Box = {
  x: PHONE_CARD.x + PHONE_PAD,
  y: PHONE_CARD.y + PHONE_CARD.h - 28 - 76,
  w: PHONE_CARD.w - 2 * PHONE_PAD,
  h: 76,
};

/** The owner's pointer, frame pixels: in from the lower right, onto the pinned button, a short rest after the click. */
export function pinnedCursorKeys(timing: {
  cursorFrom: number;
  click: number;
}): CursorKey[] {
  const x = PINNED.x + PINNED.w * 0.56;
  const y = PINNED.y + PINNED.h * 0.58;
  return [
    { at: timing.cursorFrom, x: 1110, y: 1640 },
    { at: timing.click - 0.15, x, y },
    { at: timing.click + 0.7, x: x + 10, y: y + 8 },
  ];
}

/** Lines `text` wraps to at `size` px in `width`, estimated at 0.53 em a character (Inter, medium weights). */
export function linesAt(text: string, size: number, width: number): number {
  const max = Math.floor(width / (size * 0.53));
  let lines = 1;
  let row = 0;
  for (const word of text.split(" ")) {
    const next = row === 0 ? word.length : row + 1 + word.length;
    if (next > max && row > 0) {
      lines++;
      row = word.length;
    } else {
      row = next;
    }
  }
  return lines;
}
