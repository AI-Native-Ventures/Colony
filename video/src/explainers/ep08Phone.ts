import { easeInOutCubic, progress } from "../launch/math.ts";
import { EP08 } from "./ep08.ts";
import { PHONE_CARD } from "./phone.ts";

/** The chat list's rows, card pixels. */
export const LIST = { top: 156, step: 152, h: 132 } as const;

/** The owner taps Weddings once the last topic is named, and the thread pushes in. */
export const TAP_AT = 13.75;
export const PUSH_AT = 13.95;
export const PUSH_SECONDS = 0.45;

/** The thread screen's view, under its header, card pixels. */
export const THREAD_VIEW = { top: 124, bottom: PHONE_CARD.h } as const;

/** The menus are drawn at the wide film's 280 x 420 and shown bigger. */
export const MENU_SCALE = 1.3;

/** Where things sit in the thread, thread pixels. */
export const THREAD_PHONE = {
  scout1: { y: 28, h: 100 },
  menu1: { x: 100, y: 150, w: 280 * MENU_SCALE, h: 420 * MENU_SCALE },
  reply: { y: 730, h: 150 },
  scout2: { y: 900, h: 100 },
  menu2: { x: 100, y: 1010, w: 280 * MENU_SCALE, h: 420 * MENU_SCALE },
} as const;

/** The thread's scroll: up to the reply as you write it, then to the new menu when it comes back. */
const SCROLLS: readonly { at: number; to: number; seconds: number }[] = [
  { at: 14.9, to: 200, seconds: 0.5 },
  { at: EP08.backAt, to: 900, seconds: 0.8 },
];

/** How far the thread is scrolled at `t`, px. */
export function threadScroll(t: number): number {
  let y = 0;
  for (const key of SCROLLS) {
    if (t < key.at) break;
    y += (key.to - y) * easeInOutCubic(progress(t, key.at, key.seconds));
  }
  return y;
}

/** Whether a span of the thread (its top `y`, height `h`, thread pixels) is wholly in view at `t`. */
export function inThreadView(y: number, h: number, t: number): boolean {
  const top = THREAD_VIEW.top + y - threadScroll(t);
  return top >= THREAD_VIEW.top - 0.5 && top + h <= THREAD_VIEW.bottom + 0.5;
}
