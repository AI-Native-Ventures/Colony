import type { HeroLook } from "../wide/employees.ts";
import { HERO_BOX } from "./frame.ts";

/** The tall employee row: avatar and badge, the title on one line, the subline under it. */
export const HERO = {
  avatar: { x: HERO_BOX.x + 48, y: HERO_BOX.y + 48, r: 48 },
  badgeGap: 22,
  titleTop: HERO_BOX.y + 122,
  titleSize: 92,
  titleWidth: HERO_BOX.w,
  sublineTop: HERO_BOX.y + 234,
  sublineSize: 30,
} as const;

/** The film's two-line title as one line. */
export function heroTitle(look: HeroLook): string {
  return `${look.title[0]} ${look.title[1]}`;
}

/**
 * The title's size, estimated at 0.56 em a character (Inter 800 at the
 * film's tracking). For tests only: the hero measures the real width.
 */
export function estimatedTitleSize(title: string): number {
  const width = title.length * 0.56 * HERO.titleSize;
  return width <= HERO.titleWidth
    ? HERO.titleSize
    : Math.floor(HERO.titleSize * (HERO.titleWidth / width));
}

/**
 * The slim header an employee shrinks to once its card arrives: a small
 * avatar at the card's left edge and the title beside it, half the size.
 */
export const SLIM = {
  avatar: { x: 168, y: 326, r: 28 },
  titleLeft: 212,
  titleTop: 303,
  titleSize: 46,
  /** The card's right edge: the title never runs past it. */
  right: 940,
} as const;

/** The slim title's size for a title shown at `heroSize` in the full row. */
export function slimTitleSize(heroSize: number): number {
  return (heroSize * SLIM.titleSize) / HERO.titleSize;
}
