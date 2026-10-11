import type { CursorKey } from "../app/cursorPath.ts";
import type { Point } from "../points.ts";
import type { EmployeeId } from "./employees.ts";

/** How it works, in film seconds: paste a website, Colony reads it, the team is hired. */
export const HOW = {
  avatarAt: 32.5,
  headlineAt: 33.9,
  sublineAt: 35.2,
  focusFrom: 36.5,
  cardIn: 32.8,
  cursorFrom: 33.3,
  pasteAt: 34.2,
  readClick: 34.9,
  factFrom: 35.3,
  factEvery: 0.3,
  continueClick: 36.6,
  teamAt: 36.9,
  teamEvery: 0.28,
};

export type HowTiming = typeof HOW;

export const WEBSITE = "brightplumbing.co.za";

/** What Colony reads off the website, shown as it finds it. */
export const FACTS = [
  "Plumbing",
  "Sandton and Rosebank",
  "Leaks, drains, geysers",
  "Same-day call-outs",
];

/** The real "Your business" screen as one big flat card, in panel pixels. */
export const BUSINESS_CARD = { x: 860, y: 150, w: 940, h: 760 };

type Rect = { x: number; y: number; w: number; h: number };

/** One big website field, the Read website button under it, Continue at the bottom. */
export const WEBSITE_FIELD: Rect = {
  x: BUSINESS_CARD.x + 52,
  y: BUSINESS_CARD.y + 176,
  w: BUSINESS_CARD.w - 104,
  h: 116,
};
export const READ_BUTTON: Rect = {
  x: WEBSITE_FIELD.x,
  y: WEBSITE_FIELD.y + WEBSITE_FIELD.h + 24,
  w: 300,
  h: 80,
};
export const CONTINUE_BUTTON: Rect = {
  x: BUSINESS_CARD.x + BUSINESS_CARD.w - 52 - 260,
  y: BUSINESS_CARD.y + BUSINESS_CARD.h - 52 - 76,
  w: 260,
  h: 76,
};

/** When fact `i` appears. */
export function factAt(i: number, timing: HowTiming): number {
  return timing.factFrom + i * timing.factEvery;
}

/** The owner's pointer: to Read website, then to Continue. */
export function howCursorKeys(timing: HowTiming): CursorKey[] {
  const onRead = {
    x: READ_BUTTON.x + READ_BUTTON.w * 0.55,
    y: READ_BUTTON.y + READ_BUTTON.h * 0.6,
  };
  const onContinue = {
    x: CONTINUE_BUTTON.x + CONTINUE_BUTTON.w * 0.55,
    y: CONTINUE_BUTTON.y + CONTINUE_BUTTON.h * 0.6,
  };
  return [
    { at: timing.cursorFrom, x: 1960, y: 1120 },
    { at: timing.readClick - 0.25, ...onRead },
    { at: timing.readClick + 0.5, ...onRead },
    { at: timing.continueClick - 0.25, ...onContinue },
    { at: timing.continueClick + 1.0, ...onContinue },
  ];
}

export type TeamRow = { who: EmployeeId; job: string };

/** The team Colony hires from the website, in the order the film meets them. */
export const TEAM_ROWS: TeamRow[] = [
  { who: "blue", job: "Finds customers" },
  { who: "amber", job: "Sells for you" },
  { who: "pink", job: "Makes your posts" },
  { who: "green", job: "Keeps your site fresh" },
];

/** Seconds between one team chip turning to Working and the next, top to bottom. */
export const WORKING_EVERY = 0.12;

export function teamRowAt(i: number, timing: HowTiming): number {
  return timing.teamAt + i * timing.teamEvery;
}

const TEAM_TOP = 200;
const TEAM_STEP = 132;

/** Top of team row `i`, panel pixels. */
export function teamRowY(i: number): number {
  return BUSINESS_CARD.y + TEAM_TOP + i * TEAM_STEP;
}

/** Centre of team row `i`'s avatar, panel pixels: where its river leaves from. */
export function teamAvatarSpot(i: number): Point {
  return { x: BUSINESS_CARD.x + 52 + 40, y: teamRowY(i) + 46 };
}
