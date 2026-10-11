import type { CursorKey } from "../app/cursorPath.ts";
import type { Point } from "../points.ts";
import type { EmployeeId } from "./employees.ts";
import type { Path } from "./walk.ts";

export type YesRow = {
  who: EmployeeId;
  title: string;
  /** Where in the app it lives. */
  kind: string;
  /** What happens once it is approved. */
  outcome: string;
};

/** One card per employee, waiting for the owner's OK. */
export const YES_ROWS: YesRow[] = [
  {
    who: "blue",
    title: "20 new customers in Sandton",
    kind: "Leads",
    outcome: "Saved",
  },
  {
    who: "amber",
    title: "20 emails in your words",
    kind: "Outreach",
    outcome: "Sending",
  },
  {
    who: "pink",
    title: "3 posts for Instagram",
    kind: "Posts",
    outcome: "Scheduled",
  },
  {
    who: "green",
    title: "Your new homepage",
    kind: "Website",
    outcome: "Live",
  },
];

/** The inbox card, in panel pixels. */
export const YES_CARD = { x: 860, y: 140, w: 940, h: 780 };
const ROW_TOP = 196;
const ROW_STEP = 108;
export const YES_ROW_H = 92;

/** Top of row `i`, panel pixels. */
export function yesRowY(i: number): number {
  return YES_CARD.y + ROW_TOP + i * ROW_STEP;
}

/** Where row `i`'s ant settles: at the row's left, as its owner. */
export function yesOwnerSpot(i: number): Point {
  return { x: YES_CARD.x + 52, y: yesRowY(i) + YES_ROW_H / 2 };
}

/**
 * Each employee walks in from the left edge, low enough that its tag clears
 * the owner's subline and high enough to clear the subtitles, then climbs
 * the card's left margin to its row.
 */
export function yesCarryPath(i: number): Path {
  const end = yesOwnerSpot(i);
  const turn = { x: end.x, y: 890 };
  return [{ x: -90 - i * 40, y: 880 + i * 4 }, turn, turn, end];
}

export const APPROVE_BUTTON = {
  x: YES_CARD.x + YES_CARD.w - 52 - 300,
  y: YES_CARD.y + 660,
  w: 300,
  h: 76,
};
export const SEND_BACK_BUTTON = {
  x: APPROVE_BUTTON.x - 24 - 230,
  y: APPROVE_BUTTON.y,
  w: 230,
  h: 76,
};

export type YesTiming = {
  carryFrom: number;
  carryEvery: number;
  carryDuration: number;
  cursorFrom: number;
  click: number;
  cascadeEvery: number;
  burst: number;
  outcomesAt: number;
};

export function yesCarryStart(i: number, timing: YesTiming): number {
  return timing.carryFrom + i * timing.carryEvery;
}

export function yesLandsAt(i: number, timing: YesTiming): number {
  return yesCarryStart(i, timing) + timing.carryDuration;
}

/** The pointer comes in from the bottom right corner and rests on Approve for the click. */
export function yesCursorKeys(timing: YesTiming): CursorKey[] {
  const rest = {
    x: APPROVE_BUTTON.x + APPROVE_BUTTON.w * 0.56,
    y: APPROVE_BUTTON.y + APPROVE_BUTTON.h * 0.58,
  };
  return [
    { at: timing.cursorFrom, x: 1980, y: 1130 },
    { at: timing.click - 0.3, ...rest },
    { at: timing.click + 1.5, ...rest },
  ];
}

/** Row `i` turns approved: one after another, right after the click. */
export function approvedAt(i: number, timing: YesTiming): number {
  return timing.click + 0.1 + i * timing.cascadeEvery;
}

/** Row `i` shows what happened to its work. */
export function outcomeAt(i: number, timing: YesTiming): number {
  return timing.outcomesAt + i * 0.15;
}
