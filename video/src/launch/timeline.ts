import type { Lane } from "./swarm.ts";

/** Every time in the film is in seconds, so 30 fps and 60 fps renders match. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;
export const PROOF_SECONDS = 6;
export const SEED = 20261010;
export const ANT_COUNT = 1400;

export const T_TREMBLE = 1.55;
export const T_RELEASE = 2.0;
/** Seconds from the first ant leaving (left edge) to the last (right edge). */
export const RELEASE_SWEEP = 0.45;
export const T_LOGO_IN = 4.25;
export const T_TEXT_1 = 4.45;
export const T_TEXT_2 = 4.62;

/** Where the logo lands: centered, 700 px wide, 466:309 like the brand mark. */
export const LOGO_RECT = {
  cx: 540,
  cy: 800,
  width: 700,
  height: 700 * (309 / 466),
};

/** Words stay inside x 140..940, clear of the TikTok and Reels buttons. */
export const TEXT_MAX_WIDTH = 800;

/** Four rivers, one per employee color: out towards the edges, then back into the logo. */
export const LANES: Lane[] = [
  { c1: { x: -180, y: 1150 }, c2: { x: 60, y: 260 }, spread: 110 },
  { c1: { x: 1260, y: 1250 }, c2: { x: 1020, y: 300 }, spread: 110 },
  { c1: { x: 160, y: 1900 }, c2: { x: -120, y: 700 }, spread: 120 },
  { c1: { x: 920, y: 1900 }, c2: { x: 1200, y: 760 }, spread: 120 },
];

export const timeAt = (frame: number, fps: number): number => frame / fps;
