import { smoothstep } from "../math.ts";
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
  tagline: 22.3,
  /** The name steps back and "AI employee" is defined. */
  defineFrom: 25.6,
  teamWalkFrom: 27.0,
  /** The bright product world opens from the centre. */
  brightFrom: 31.3,
  brightTo: 32.3,
};

/**
 * What an AI employee is, on screen while the voice says it. The owner's
 * wording (2026-10-11): AI employees are AI agents.
 */
export const DEFINITION = {
  title: "AI employees",
  body: "AI agents that do office work for you, like people on your team.",
} as const;

/**
 * How visible the swarm is: whole until the logo flashes in, then gone as the
 * solid logo lands, so no ants are left fuzzing its edge (the owner saw that
 * as a "weird shadow", 2026-10-11).
 */
export function swarmFade(t: number): number {
  return 1 - smoothstep(INTRO.logoIn, INTRO.logoIn + 0.45, t);
}

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
  { text: "Find customers", at: 7.0, size: 96 },
  { text: "Reply to emails", at: 7.9, size: 104 },
  { text: "Post on Instagram", at: 8.6, size: 88 },
  { text: "Update the website", at: 9.55, size: 86 },
  { text: "Send quotes", at: 10.3, size: 102 },
  { text: "Chase invoices", at: 10.8, size: 94 },
  { text: "Do the books", at: 11.25, size: 104 },
  { text: "Answer the phone", at: 11.6, size: 90 },
  { text: "Write the newsletter", at: 11.9, size: 84 },
];

export const TOWER_STACK: StackOptions = {
  centerY: 540,
  leading: 0.94,
  pushSeconds: 0.22,
};
export const TOWER_MAX_WIDTH = 1300;

/** Where the logo lands: centred in the top half, 400 px wide. */
export const WIDE_LOGO_RECT = {
  cx: 960,
  cy: 380,
  width: 400,
  height: 400 * (309 / 466),
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
