import type { Lane } from "./swarm.ts";

/** Every time in the film is in seconds, so 30 fps and 60 fps renders match. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;
export const SEED = 20261010;
export const ANT_COUNT = 900;

/**
 * The tower stands complete from about 3.7 s; it trembles, then breaks into
 * ants. The break is placed so the logo flash (T_LOGO_IN) lands on the music
 * lift at 7.0 s (film.ts MUSIC_LIFT).
 */
export const T_TREMBLE = 4.35;
export const T_RELEASE = 4.75;
/** Seconds from the first ant leaving (left edge) to the last (right edge). */
export const RELEASE_SWEEP = 0.45;
/** Everything after the break is timed from it, so the words can be retimed alone. */
export const T_LOGO_IN = T_RELEASE + 2.25;
export const T_TEXT_1 = T_LOGO_IN + 0.2;
export const T_TEXT_2 = T_LOGO_IN + 0.37;
export const PROOF_SECONDS = T_LOGO_IN + 1.95;

/** Where the logo lands: centered, 700 px wide, 466:309 like the brand mark. */
export const LOGO_RECT = {
  cx: 540,
  cy: 800,
  width: 700,
  height: 700 * (309 / 466),
};

/** Words stay inside x 140..940, clear of the TikTok and Reels buttons. */
export const TEXT_MAX_WIDTH = 800;

/**
 * Four rivers, one per employee color, in slice order left to right (see
 * colors.ts): out towards the edges, then back into their part of the logo.
 */
export const LANES: Lane[] = [
  { c1: { x: -180, y: 1150 }, c2: { x: 60, y: 260 }, spread: 110 },
  { c1: { x: 160, y: 1900 }, c2: { x: -120, y: 700 }, spread: 120 },
  { c1: { x: 920, y: 1900 }, c2: { x: 1200, y: 760 }, spread: 120 },
  { c1: { x: 1260, y: 1250 }, c2: { x: 1020, y: 300 }, spread: 110 },
];

export const timeAt = (frame: number, fps: number): number => frame / fps;
