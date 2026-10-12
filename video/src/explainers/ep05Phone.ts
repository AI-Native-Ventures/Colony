import type { CursorKey } from "../launch/app/cursorPath.ts";
import { easeInOutCubic, progress } from "../launch/math.ts";
import type { Box } from "../launch/tall/frame.ts";
import type { Path } from "../launch/wide/walk.ts";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";

/**
 * Episode 5's posts on the phone card: a feed of big posts, each with its
 * time under it, one under the other. Card pixels unless a name says frame.
 */
export const FEED = {
  /** Where the feed's view starts and ends inside the card. */
  top: 268,
  bottom: 904,
  /** A post's side, and how far apart posts sit. */
  post: 460,
  step: 564,
  /** The time row under a post. */
  timeGap: 18,
  timeH: 44,
} as const;

/** The posts' left edge inside the card: centred. */
export const FEED_LEFT = (PHONE_CARD.w - FEED.post) / 2;

/**
 * The feed's scroll: down to the second and third posts while the voice
 * says what it makes, back up post by post as each time is set.
 */
const SCROLLS: readonly { at: number; to: number; seconds: number }[] = [
  { at: 14.6, to: FEED.step, seconds: 0.45 },
  { at: 15.55, to: 2 * FEED.step, seconds: 0.45 },
  { at: 18.65, to: FEED.step, seconds: 0.4 },
  { at: 19.45, to: 0, seconds: 0.35 },
];

/** How far the feed is scrolled at `t`, px. */
export function feedScroll(t: number): number {
  let y = 0;
  for (const key of SCROLLS) {
    if (t < key.at) break;
    y += (key.to - y) * easeInOutCubic(progress(t, key.at, key.seconds));
  }
  return y;
}

/** When each post's time is set: the last post first, as the feed scrolls back up. */
export const TIME_AT: readonly number[] = [19.85, 19.1, 18.2];

/** The top of post `i`'s slot inside the card at `t`. */
export function slotTop(i: number, t: number): number {
  return FEED.top + i * FEED.step - feedScroll(t);
}

/** Whether post `i` and its time are wholly inside the feed's view at `t`. */
export function slotInView(i: number, t: number): boolean {
  const top = slotTop(i, t);
  const bottom = top + FEED.post + FEED.timeGap + FEED.timeH;
  return top >= FEED.top - 0.5 && bottom <= FEED.bottom + 0.5;
}

/** Where a carrier puts its post down, frame pixels: in the card's right margin, beside the first post. */
export const DROP = { x: 836, y: 1040 };

/** A carrier's walk, frame pixels: in from off the right edge, above Instagram's buttons. */
export function phoneCarryPath(i: number): Path {
  return [
    { x: 1160 + i * 40, y: 1030 + i * 6 },
    { x: 1040, y: 1032 },
    { x: 900, y: 1036 },
    DROP,
  ];
}

/** The pinned Approve button at the card's foot, below the first post's time, frame pixels. */
export const APPROVE: Box = {
  x: PHONE_CARD.x + PHONE_PAD,
  y: PHONE_CARD.y + PHONE_CARD.h - 28 - 76,
  w: PHONE_CARD.w - 2 * PHONE_PAD,
  h: 76,
};

/** The owner's pointer, frame pixels: in from the lower right, onto Approve, a short rest after the click. */
export function phoneCursorKeys(timing: {
  cursorFrom: number;
  click: number;
}): CursorKey[] {
  const x = APPROVE.x + APPROVE.w * 0.56;
  const y = APPROVE.y + APPROVE.h * 0.58;
  return [
    { at: timing.cursorFrom, x: 1110, y: 1640 },
    { at: timing.click - 0.15, x, y },
    { at: timing.click + 0.7, x: x + 10, y: y + 8 },
  ];
}
