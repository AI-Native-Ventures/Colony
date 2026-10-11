import type { CursorKey } from "../app/cursorPath.ts";
import type { Point } from "../points.ts";
import type { EmployeeId } from "./employees.ts";
import { typewriterEnd } from "./typewriter.ts";

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
  /** Seconds "Reading your website…" shows before the summary starts. */
  readFor: 1.0,
  summaryCps: 70,
  continueClick: 37.25,
  teamAt: 37.55,
  teamEvery: 0.28,
};

export type HowTiming = typeof HOW;

export const WEBSITE = "brightplumbing.co.za";
export const SUMMARY_TEXT =
  "We fix leaks, blocked drains and geysers in Sandton and Rosebank, the same day.";

/** The real "Your business" screen as one big flat card, in panel pixels. */
export const BUSINESS_CARD = { x: 860, y: 150, w: 940, h: 760 };

type Rect = { x: number; y: number; w: number; h: number };

/** The website field and the two buttons, in panel pixels. */
export const WEBSITE_FIELD: Rect = {
  x: BUSINESS_CARD.x + 52,
  y: BUSINESS_CARD.y + 330,
  w: 600,
  h: 76,
};
export const READ_BUTTON: Rect = {
  x: WEBSITE_FIELD.x + WEBSITE_FIELD.w + 20,
  y: WEBSITE_FIELD.y,
  w:
    BUSINESS_CARD.x +
    BUSINESS_CARD.w -
    52 -
    (WEBSITE_FIELD.x + WEBSITE_FIELD.w + 20),
  h: 76,
};
export const CONTINUE_BUTTON: Rect = {
  x: BUSINESS_CARD.x + BUSINESS_CARD.w - 52 - 260,
  y: BUSINESS_CARD.y + 650,
  w: 260,
  h: 76,
};

/** When the summary, read from the website, is fully written. */
export function summaryTypedAt(timing: HowTiming): number {
  return typewriterEnd([SUMMARY_TEXT], {
    start: timing.readClick + timing.readFor,
    cps: timing.summaryCps,
    returnSeconds: 0,
  });
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
  { who: "amber", job: "Writes your emails" },
  { who: "pink", job: "Makes your posts" },
  { who: "green", job: "Keeps your site fresh" },
];

export function teamRowAt(i: number, timing: HowTiming): number {
  return timing.teamAt + i * timing.teamEvery;
}

const TEAM_TOP = 210;
const TEAM_STEP = 118;

/** Top of team row `i`, panel pixels. */
export function teamRowY(i: number): number {
  return BUSINESS_CARD.y + TEAM_TOP + i * TEAM_STEP;
}

/** Centre of team row `i`'s avatar, panel pixels: where its river leaves from. */
export function teamAvatarSpot(i: number): Point {
  return { x: BUSINESS_CARD.x + 52 + 40, y: teamRowY(i) + 46 };
}
