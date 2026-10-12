import { PHONE_CARD, PHONE_PAD } from "../../explainers/phone.ts";
import type { CursorKey } from "../app/cursorPath.ts";
import type { Point } from "../points.ts";
import type { LeadsSetup } from "../../explainers/LeadsPhone";
import type { Plan } from "../../explainers/PlanPhone";
import type { SalesSetup } from "../../explainers/SalesPhone";
import { LEADS } from "../wide/beat.ts";
import { CALL } from "../wide/call.ts";
import { EMAIL } from "../wide/email.ts";
import type { Path } from "../wide/walk.ts";
import { HOW } from "../wide/how.ts";
import { SCOUT_TASKS } from "../wide/scout.ts";
import {
  AMBER90,
  BLUE90,
  GREEN90,
  type PanelId,
  PINK90,
  SCOUT90,
  YES90,
} from "../wide/film90.ts";

/**
 * When each Reels film page's employee row shrinks into the slim header:
 * before its avatar pops, so it arrives slim. The film's cards come with the
 * employee, leaving no time for the full row (owner, 2026-10-12: the film
 * gets the explainers' phone screens).
 */
export const FILM_COMPACT_AT: Record<Exclude<PanelId, "day">, number> = {
  how: HOW.avatarAt - 0.6,
  scout: SCOUT90.avatarAt - 0.6,
  blue: BLUE90.avatarAt - 0.6,
  amber: AMBER90.avatarAt - 0.6,
  pink: PINK90.avatarAt - 0.6,
  green: GREEN90.avatarAt - 0.6,
  yes: YES90.avatarAt - 0.6,
};

/** Scout's plan on the film's phone card: today's four jobs, no request, so the rows start under Scout. */
export const FILM_PLAN: Plan = {
  title: "Today's plan.",
  tasks: SCOUT_TASKS,
  rows: { top: 214, step: 132, h: 116 },
};

/** The centre of job `i`'s employee avatar on the film's plan card, frame pixels. */
export function filmPlanAvatar(i: number): { x: number; y: number } {
  return {
    x: PHONE_CARD.x + PHONE_PAD + 22 + 36,
    y: PHONE_CARD.y + FILM_PLAN.rows.top + i * FILM_PLAN.rows.step + 22 + 36,
  };
}

/** The film's Sandton leads on the phone card: area and score, no request or picks. */
export const FILM_LEADS: LeadsSetup = {
  leads: LEADS,
  subline: "Businesses near Sandton that need a plumber",
  rowsTop: 176,
};

/** Thabo's email and Lindiwe's call on the film's phone card: the subject on two lines, the call stacked by height; nothing sent, no reply or yes here. */
export const FILM_SALES: SalesSetup = {
  email: EMAIL,
  subjectLines: ["A plumbing partner for", "Grayston Office Park"],
  call: CALL,
  stackCall: true,
};

/** The film's three posts on the phone card, a row each: the post on the left, its time and "Instagram" on the right. Card pixels. */
export const FILM_POST_ROWS = {
  top: 124,
  step: 264,
  post: 248,
  textLeft: 324,
} as const;

/** The top of post row `i`, card pixels. */
export function filmPostTop(i: number): number {
  return FILM_POST_ROWS.top + i * FILM_POST_ROWS.step;
}

/** A pink carrier's walk into row `i`, card pixels: in from past the card's right edge, stopping right of the row's time. */
export function filmPostCarryPath(i: number): Path {
  const y = filmPostTop(i) + FILM_POST_ROWS.post / 2 + 36;
  return [
    { x: PHONE_CARD.w + 70 + i * 14, y: y - 26 },
    { x: PHONE_CARD.w - 30, y: y - 12 },
    { x: 740, y },
    { x: 690, y },
  ];
}

/** Bright's site as it was, on a phone, top to bottom: page pixels, 800 wide, under the browser bar. */
export const BRIGHT_OLD_PHONE = {
  header: { top: 0, bottom: 120 },
  nav: { top: 120, bottom: 164 },
  welcome: { top: 192, bottom: 532 },
  photo: { top: 552, bottom: 662 },
  prices: { top: 680, bottom: 712 },
  footer: { top: 748, bottom: 832 },
} as const;

/** Bright's repainted site on a phone, top to bottom: page pixels, 800 wide, under the browser bar. */
export const BRIGHT_PHONE = {
  header: { top: 0, bottom: 92 },
  hero: { top: 92, bottom: 440 },
  panel: { top: 452, bottom: 652 },
  services: { top: 668, bottom: 824 },
} as const;

/** The film's inbox on the phone card: a row per piece of work under the line. Card pixels. */
export const INBOX_ROWS = {
  top: 164,
  step: 148,
  h: 132,
  textLeft: 112,
} as const;

/** The top of inbox row `i`, card pixels. */
export function inboxRowTop(i: number): number {
  return INBOX_ROWS.top + i * INBOX_ROWS.step;
}

/** Where row `i`'s employee settles, card pixels: at the row's left, as its owner. */
export function inboxOwnerSpot(i: number): Point {
  return { x: 64, y: inboxRowTop(i) + INBOX_ROWS.h / 2 };
}

/** An employee's walk into row `i`, card pixels: in past the card's left edge, along to its spot. */
export function inboxCarryPath(i: number): Path {
  const end = inboxOwnerSpot(i);
  return [
    { x: -80 - i * 30, y: end.y + 40 },
    { x: 0, y: end.y + 16 },
    { x: 30, y: end.y },
    end,
  ];
}

/** "Send it back" and "Approve all", pinned to the card's foot. Card pixels. */
export const INBOX_BUTTONS = {
  top: PHONE_CARD.h - 28 - 76,
  h: 76,
  sendBack: { left: PHONE_PAD, w: 252 },
  approve: {
    left: PHONE_PAD + 252 + 16,
    w: PHONE_CARD.w - 2 * PHONE_PAD - 252 - 16,
  },
} as const;

/** The owner's pointer, frame pixels: in from the lower right, at rest on Approve all for the click. */
export function inboxCursorKeys(timing: {
  cursorFrom: number;
  click: number;
}): CursorKey[] {
  const rest = {
    x:
      PHONE_CARD.x +
      INBOX_BUTTONS.approve.left +
      INBOX_BUTTONS.approve.w * 0.56,
    y: PHONE_CARD.y + INBOX_BUTTONS.top + INBOX_BUTTONS.h * 0.58,
  };
  return [
    { at: timing.cursorFrom, x: 1110, y: 1640 },
    { at: timing.click - 0.3, ...rest },
    { at: timing.click + 1.5, ...rest },
  ];
}
