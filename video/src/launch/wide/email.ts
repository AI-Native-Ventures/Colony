import { easeInOutCubic, progress } from "../math.ts";
import { typewriterEnd } from "./typewriter.ts";

/** The draft the amber employee writes, an example for Bright Plumbing. */
export const EMAIL = {
  to: "Thabo",
  company: "Rosebank Auto Care",
  subject: "Leaky pipes at the workshop?",
  lines: [
    "Hi Thabo,",
    "We fix leaks and blocked drains for workshops",
    "in Rosebank. Can we take a look this week?",
  ],
} as const;

/** The longest body line that fits the card at the body size. */
export const MAX_LINE_CHARS = 46;

/** The email card, in panel pixels. */
export const EMAIL_CARD = { x: 860, y: 150, w: 940, h: 760 };

/** Body text inside the card. */
export const BODY = { x: 52, top: 430, lineHeight: 54, gapAfterGreeting: 14 };
export const BODY_FONT_SIZE = 30;

/** Top of body line `i`, card pixels. */
export function bodyLineTop(i: number): number {
  return BODY.top + i * BODY.lineHeight + (i > 0 ? BODY.gapAfterGreeting : 0);
}

export type DraftCountTiming = {
  typeFrom: number;
  typeCps: number;
  returnSeconds: number;
  countRushFrom: number;
  countRush: number;
};

/** When the last letter of Thabo's email is typed. */
export function emailTypedAt(timing: DraftCountTiming): number {
  return typewriterEnd([...EMAIL.lines], {
    start: timing.typeFrom,
    cps: timing.typeCps,
    returnSeconds: timing.returnSeconds,
  });
}

/** Drafts ready: none while typing, one when Thabo's is done, then a quick count to 20. */
export function draftsReady(t: number, timing: DraftCountTiming): number {
  if (t < emailTypedAt(timing) + 0.1) return 0;
  const rush = easeInOutCubic(
    progress(t, timing.countRushFrom, timing.countRush),
  );
  return 1 + Math.round(19 * rush);
}
