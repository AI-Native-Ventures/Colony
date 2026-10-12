import { PHONE_PAD } from "./phone.ts";

/** Episode 1's plan on the phone card, card pixels. */

/** Scout's row under the title: the avatar the jobs are dealt from. */
export const SCOUT_ROW = { top: 116, avatar: 64 } as const;

/** Where Scout's avatar centre is, card pixels. */
export const SCOUT_AT = {
  x: PHONE_PAD + SCOUT_ROW.avatar / 2,
  y: SCOUT_ROW.top + SCOUT_ROW.avatar / 2,
} as const;

/** "You asked" and the request. */
export const REQUEST_TOP = 206;

/** The jobs, one big row each. */
export const ROWS = { top: 356, step: 132, h: 116 } as const;

/** Where a job's words start, right of its employee's avatar. */
export const TASK_TEXT_LEFT = 140;

/** "Scout checks every piece before it reaches you." */
export const NOTE_TOP = 750;
