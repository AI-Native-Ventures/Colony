import type { StackOptions } from "../stack.ts";
import type { Lane } from "../swarm.ts";

/**
 * The wide film's opening, in film seconds: who it is for (trades, then the
 * pile of jobs), the swarm, the logo, "Introducing Colony", what Colony is,
 * and what an AI employee is.
 */
export const INTRO = {
  /** The single glowing ant fades as the first trade appears. */
  tradesOut: 4.7,
  tremble: 14.35,
  release: 14.75,
  releaseSweep: 0.45,
  /** Logo flash, on the music lift. */
  logoIn: 17.0,
  introducing: 17.2,
  name: 17.37,
  tagline: 22.4,
  /** The name steps back and "AI employee" is defined. */
  defineFrom: 25.6,
  teamWalkFrom: 27.2,
  /** The bright product world opens from the centre. */
  brightFrom: 32.4,
  brightTo: 33.4,
};

export type TimedWord = { text: string; at: number };

/** "The work you love": a few trades, each long enough to read. */
export const TRADE_WORDS: TimedWord[] = [
  { text: "Plumbing.", at: 1.2 },
  { text: "Baking.", at: 1.8 },
  { text: "Haircuts.", at: 2.4 },
  { text: "Building.", at: 3.0 },
  { text: "Photography.", at: 3.6 },
];

export type TowerWord = TimedWord & { size: number };

/** "Then came everything else": the jobs said aloud land as they are said, then the rest pile on. */
export const TOWER_WORDS: TowerWord[] = [
  { text: "Find customers", at: 6.4, size: 96 },
  { text: "Reply to emails", at: 7.3, size: 104 },
  { text: "Post on Instagram", at: 8.1, size: 88 },
  { text: "Update the website", at: 8.9, size: 86 },
  { text: "Send quotes", at: 9.6, size: 102 },
  { text: "Chase invoices", at: 10.15, size: 94 },
  { text: "Do the books", at: 10.65, size: 104 },
  { text: "Answer the phone", at: 11.05, size: 90 },
  { text: "Write the newsletter", at: 11.4, size: 84 },
];

export const TOWER_STACK: StackOptions = {
  centerY: 540,
  leading: 0.94,
  pushSeconds: 0.22,
};
export const TOWER_MAX_WIDTH = 1300;

/** Where the logo lands: centred in the top half, 470 px wide. */
export const WIDE_LOGO_RECT = {
  cx: 960,
  cy: 360,
  width: 470,
  height: 470 * (309 / 466),
};

export const WIDE_ANT_COUNT = 900;
export const WIDE_SEED = 20261011;

/**
 * Four rivers in slice order, left to right (colors.ts GROUP_RGB order:
 * blue, amber, green, pink): out to the edges, then back into their part of
 * the logo.
 */
export const WIDE_LANES: Lane[] = [
  { c1: { x: -220, y: 760 }, c2: { x: 260, y: 40 }, spread: 120 },
  { c1: { x: 260, y: 1220 }, c2: { x: -160, y: 380 }, spread: 130 },
  { c1: { x: 1660, y: 1220 }, c2: { x: 2080, y: 380 }, spread: 130 },
  { c1: { x: 2140, y: 760 }, c2: { x: 1660, y: 40 }, spread: 120 },
];
