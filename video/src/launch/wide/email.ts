import { easeInOutCubic, progress } from "../math.ts";
import { typewriterEnd } from "./typewriter.ts";

/**
 * The draft the sales employee writes, an example for Bright Plumbing: a
 * partnership pitch to an office park, not a one-off repair (owner, 2026-10-11).
 */
export const EMAIL = {
  to: "Thabo",
  company: "Grayston Office Park",
  subject: "A plumbing partner for Grayston Office Park",
  lines: [
    "Hi Thabo,",
    "Bright Plumbing looks after office parks",
    "across Sandton. We would like to be your",
    "on-call plumber: one contract, same-day",
    "call-outs. Could we meet for 15 minutes",
    "next week?",
  ],
} as const;

/** The longest body line that fits the card at the body size. */
export const MAX_LINE_CHARS = 46;

/** The email card, in panel pixels. */
export const EMAIL_CARD = { x: 860, y: 150, w: 940, h: 760 };

/** Body text inside the card. */
export const BODY = { x: 52, top: 404, lineHeight: 50, gapAfterGreeting: 12 };
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
