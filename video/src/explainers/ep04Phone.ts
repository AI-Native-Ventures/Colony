import { EP04 } from "./ep04.ts";

/** Episode 4 on the phone card, card pixels. */

/** The email: who it is to, the subject, then the body the pen ant writes. */
export const RECIPIENT_TOP = 124;
export const DIVIDER_TOP = 214;
export const SUBJECT_TOP = 234;
export const PHONE_BODY = {
  top: 300,
  lineHeight: 48,
  gapAfterGreeting: 12,
  size: 30,
} as const;

/** A second line of subject pushes the body down by one subject line. */
export const SUBJECT_LINE = 44;

/** Where the body starts under a subject of `lines` lines. */
export function phoneBodyTop(lines = 1): number {
  return PHONE_BODY.top + (lines - 1) * SUBJECT_LINE;
}

/** Top of body line `i`, the body starting at `top`. */
export function phoneBodyLineTop(
  i: number,
  top: number = PHONE_BODY.top,
): number {
  return (
    top + i * PHONE_BODY.lineHeight + (i > 0 ? PHONE_BODY.gapAfterGreeting : 0)
  );
}

/** The venue's answer, under the email. */
export const REPLY_PHONE = { top: 600, h: 160 } as const;

/** The call screen pushes in as the voice says it calls. */
export const PUSH_AT = EP04.callIn;
export const PUSH_SECONDS = 0.45;

/** The call screen: the venue's avatar, name, timer and voice, the two lines said, the booking. */
export const CALL_PHONE = {
  avatarCy: 112,
  avatar: 128,
  nameTop: 192,
  companyTop: 242,
  timerTop: 280,
  waveTop: 330,
  waveH: 50,
  usTop: 400,
  themTop: 526,
  /** The widest a speech bubble gets. */
  bubbleW: 640,
  bookedTop: 620,
  bookedH: 60,
} as const;

/** The gap between the call's bubbles and the booking when they stack by their height. */
export const CALL_STACK_GAP = 22;

/** The sheet that slides up for your yes: the next emails, and Approve at its foot. */
export const SHEET = { top: 700, titleTop: 728, subTop: 776 } as const;
