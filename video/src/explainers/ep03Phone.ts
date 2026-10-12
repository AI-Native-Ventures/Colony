import type { CursorKey } from "../launch/app/cursorPath.ts";
import type { Box } from "../launch/tall/frame.ts";
import type { Path } from "../launch/wide/walk.ts";
import { EP03_PICKS } from "./ep03.ts";
import { PHONE_CARD, PHONE_PAD, PINNED } from "./phone.ts";

/** Episode 3 on the phone card, card pixels unless a name says frame. */

/** "Leads.": a row per lead under the request. */
export const LEAD_ROWS = { top: 236, step: 92, h: 82 } as const;
/** Where a carrier ant settles at its row's left, and where the name starts. */
export const OWNER_X = 64;
export const NAME_LEFT = 112;
export const TICK_SIZE = 44;

/** Row `row`'s tick box, frame pixels. */
export function tickBox(row: number): Box {
  return {
    x: PHONE_CARD.x + PHONE_CARD.w - PHONE_PAD - TICK_SIZE,
    y:
      PHONE_CARD.y +
      LEAD_ROWS.top +
      row * LEAD_ROWS.step +
      (LEAD_ROWS.h - TICK_SIZE) / 2,
    w: TICK_SIZE,
    h: TICK_SIZE,
  };
}

/** A carrier's walk into row `i` (rows from `top`): in from the card's left edge, along the row to its owner spot. */
export function leadCarryPath(i: number, top: number = LEAD_ROWS.top): Path {
  const y = top + i * LEAD_ROWS.step + LEAD_ROWS.h / 2;
  return [
    { x: -70 - i * 12, y: y + 34 },
    { x: 10, y: y + 12 },
    { x: 36, y },
    { x: OWNER_X, y },
  ];
}

/** The pointer ticking the picks top to bottom, frame pixels. */
export function tickCursorKeys(timing: {
  tickCursorFrom: number;
}): CursorKey[] {
  const keys: CursorKey[] = [{ at: timing.tickCursorFrom, x: 1110, y: 1640 }];
  for (const p of EP03_PICKS) {
    const box = tickBox(p.row);
    keys.push({ at: p.at - 0.1, x: box.x + box.w / 2, y: box.y + box.h / 2 });
  }
  const last = keys[keys.length - 1];
  keys.push({ at: last.at + 0.6, x: last.x + 10, y: last.y + 8 });
  return keys;
}

/** After the last pick and the hand-over, the sales employee's screen pushes in. */
export const PUSH_AT = 19.25;
export const PUSH_SECONDS = 0.45;

/** "Outreach.": the five picks, a row each, landing one after another. */
export const PICK_ROWS = { top: 196, step: 116, h: 100 } as const;

/** When pick `k` lands in the sales screen's list. */
export function pickLandsAt(
  k: number,
  timing: { chipFrom: number; chipEvery: number },
): number {
  return timing.chipFrom + k * timing.chipEvery + 0.35;
}

/** The pointer coming to rest on Approve, unpressed, frame pixels. */
export function restCursorKeys(timing: {
  restFrom: number;
  restAt: number;
}): CursorKey[] {
  return [
    { at: timing.restFrom, x: 1110, y: 1640 },
    {
      at: timing.restAt,
      x: PINNED.x + PINNED.w * 0.56,
      y: PINNED.y + PINNED.h * 0.58,
    },
  ];
}
