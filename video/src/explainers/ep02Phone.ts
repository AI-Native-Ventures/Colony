import type { CursorKey } from "../launch/app/cursorPath.ts";
import { EP02 } from "./ep02.ts";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";

/** Episode 2 on the phone card, card pixels. */

/** "Your business.": the website field, Read website, the facts as rows. */
export const FIELD = { top: 186, h: 110 } as const;
export const READ = { top: 318, h: 84 } as const;
export const FACT_ROWS = { top: 486, step: 88, h: 74 } as const;

/** The card turns to the team just after Continue, when Colony is done reading. */
export const PUSH_DELAY = 0.1;
export const PUSH_AT = EP02.continueClick + PUSH_DELAY;
export const PUSH_SECONDS = 0.45;

/** "Your team.": a row per employee, then Scout. */
export const TEAM = { top: 186, step: 114, h: 100 } as const;
export const SCOUT_ROW_TOP = 650;

/** The pointer onto Read website, frame pixels: in from the lower right, a press, then away. */
export function readCursorKeys(timing: {
  cursorFrom: number;
  readClick: number;
}): CursorKey[] {
  const x = PHONE_CARD.x + PHONE_PAD + (PHONE_CARD.w - 2 * PHONE_PAD) * 0.56;
  const y = PHONE_CARD.y + READ.top + READ.h * 0.58;
  return [
    { at: timing.cursorFrom, x: 1110, y: 1640 },
    { at: timing.readClick - 0.15, x, y },
    { at: timing.readClick + 0.7, x: x + 10, y: y + 8 },
  ];
}
