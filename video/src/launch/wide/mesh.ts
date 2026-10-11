import { smoothstep } from "../math.ts";

/** One soft colour field, in percent of the frame. */
export type Blob = {
  color: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
};

/** A light band laid diagonally across the blobs, so the colours weave. */
export type Band = { angle: number; color: string; from: number; to: number };

export type Palette = { base: string; blobs: Blob[]; band: Band };

/**
 * Soft, interweaving gradients sampled from the owner's Colony posts
 * (2026-10-11): a light base, a few large colour fields, a pale diagonal band.
 */
export const PALETTES = {
  mintPink: {
    base: "#ead0de",
    blobs: [
      { color: "#34b78a", x: 96, y: -6, rx: 62, ry: 46 },
      { color: "#e8f2ef", x: 8, y: 8, rx: 72, ry: 52 },
      { color: "#e6a7c8", x: 24, y: 88, rx: 82, ry: 62 },
      { color: "#eebcd6", x: 82, y: 76, rx: 62, ry: 52 },
    ],
    band: { angle: 160, color: "rgb(241 238 243 / 0.88)", from: 22, to: 52 },
  },
  sea: {
    base: "#cfe3f2",
    blobs: [
      { color: "#36b590", x: 92, y: 6, rx: 66, ry: 56 },
      { color: "#4fb1a8", x: 56, y: 18, rx: 40, ry: 34 },
      { color: "#9ec4de", x: 18, y: 46, rx: 46, ry: 40 },
      { color: "#eef5fb", x: 24, y: 96, rx: 72, ry: 46 },
    ],
    band: { angle: 135, color: "rgb(231 241 250 / 0.7)", from: 36, to: 58 },
  },
  sunset: {
    base: "#f2b85a",
    blobs: [
      { color: "#ee7fa6", x: 96, y: -2, rx: 56, ry: 42 },
      { color: "#fbe3e3", x: 14, y: 24, rx: 72, ry: 36 },
      { color: "#eea847", x: 86, y: 96, rx: 62, ry: 52 },
      { color: "#f4b756", x: 20, y: 80, rx: 60, ry: 45 },
    ],
    band: { angle: 165, color: "rgb(252 233 232 / 0.82)", from: 24, to: 46 },
  },
  lilac: {
    base: "#e2c9ee",
    blobs: [
      { color: "#b69af8", x: 0, y: 0, rx: 58, ry: 48 },
      { color: "#d48ccd", x: 92, y: 72, rx: 62, ry: 56 },
      { color: "#efe8fc", x: 44, y: 34, rx: 56, ry: 30 },
      { color: "#b9b3ea", x: 96, y: 102, rx: 36, ry: 26 },
    ],
    band: { angle: 150, color: "rgb(246 241 253 / 0.86)", from: 30, to: 52 },
  },
  sky: {
    base: "#dfe2fb",
    blobs: [
      { color: "#7ea9f5", x: 102, y: 30, rx: 46, ry: 62 },
      { color: "#c7cffb", x: 0, y: 0, rx: 62, ry: 46 },
      { color: "#84b1f8", x: -2, y: 100, rx: 42, ry: 36 },
      { color: "#f1f1fd", x: 46, y: 74, rx: 56, ry: 36 },
    ],
    band: { angle: 120, color: "rgb(242 242 254 / 0.72)", from: 34, to: 56 },
  },
  orchid: {
    base: "#e2b7e6",
    blobs: [
      { color: "#c3aefb", x: 0, y: 10, rx: 56, ry: 62 },
      { color: "#ef9fd3", x: 100, y: 44, rx: 52, ry: 56 },
      { color: "#ead8fb", x: 40, y: 50, rx: 42, ry: 40 },
      { color: "#b9b5f0", x: 92, y: 100, rx: 36, ry: 26 },
    ],
    band: { angle: 145, color: "rgb(246 236 252 / 0.62)", from: 28, to: 50 },
  },
} satisfies Record<string, Palette>;

export type PaletteId = keyof typeof PALETTES;

/** From `at` (film seconds) this palette is the background. */
export type PaletteStop = { id: PaletteId; at: number };

/**
 * The light world behind the opening and the close: the work you love, the
 * pile of jobs, the logo, what an AI employee is; then the close.
 */
export const LIGHT_WORLD: PaletteStop[] = [
  { id: "mintPink", at: 0 },
  { id: "sunset", at: 5.4 },
  { id: "lilac", at: 14.6 },
  { id: "sky", at: 25.2 },
  { id: "orchid", at: 108.6 },
];

const FADE = 1.2;

/** Which palettes show at `t` and how strongly: one, or two while crossfading. */
export function paletteWeights(
  t: number,
  stops: readonly PaletteStop[],
  fade = FADE,
): { id: PaletteId; weight: number }[] {
  let current = 0;
  for (let i = 1; i < stops.length; i++) {
    if (t >= stops[i].at - fade / 2) current = i;
  }
  const stop = stops[current];
  if (current === 0) return [{ id: stop.id, weight: 1 }];
  const k = smoothstep(stop.at - fade / 2, stop.at + fade / 2, t);
  if (k >= 1) return [{ id: stop.id, weight: 1 }];
  return [
    { id: stops[current - 1].id, weight: 1 - k },
    { id: stop.id, weight: k },
  ];
}
