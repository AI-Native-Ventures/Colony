import { easeInOutCubic, progress } from "../launch/math.ts";
import { PHONE_CARD } from "./phone.ts";
import { MO_NOW } from "./mo.ts";

/** Episode 6 on the phone card: a phone browser showing Mo's page. Card pixels. */

/** The browser bar: the address, then Before and After. */
export const BAR_H = 92;
/** The page under it fills the rest of the card. */
export const PAGE_H = PHONE_CARD.h - BAR_H;

/** Your request, in a bubble over the foot of the page while you type it. */
export const REQUEST_BUBBLE = { left: 44, bottom: 40, w: 712, h: 200 } as const;

/** The new page's two tiles, page pixels: what changed, high enough to stay above the pinned button. */
export const NEW_TILES = [
  { label: "FULL SERVICE", value: MO_NOW.service, top: 362, h: 140 },
  { label: "NOW OPEN SATURDAYS", value: MO_NOW.saturday, top: 518, h: 140 },
] as const;

/** How far down the page the painter has repainted at `t`, page pixels. */
export function wipeY(
  t: number,
  timing: { paintFrom: number; paintDuration: number },
): number {
  return (
    PAGE_H * easeInOutCubic(progress(t, timing.paintFrom, timing.paintDuration))
  );
}
