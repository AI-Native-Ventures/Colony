import { easeInOutCubic, progress } from "../math.ts";
import type { Point } from "../points.ts";
import type { Path } from "./walk.ts";

/** The wide film frame. */
export const WIDE_W = 1920;
export const WIDE_H = 1080;

/** The "finds customers" proof beat, in seconds. */
export const BEAT_SECONDS = 15;
export const BEAT = {
  riverFrom: -0.2,
  brightFrom: 1.7,
  brightTo: 2.7,
  avatarAt: 2.3,
  boardIn: 3.6,
  carryFrom: 5.2,
  carryEvery: 0.58,
  carryDuration: 1.7,
  countRushFrom: 10.3,
  countRush: 1.3,
};

export type BeatLine = {
  id: string;
  file: string;
  at: number;
  speech: readonly [number, number];
  text: string;
};

export const BEAT_VOICE: BeatLine[] = [
  {
    id: "blue-1",
    file: "launch/vo-blue-1.mp3",
    at: 2.3,
    speech: [2.5, 4.45],
    text: "This one finds customers.",
  },
  {
    id: "blue-2",
    file: "launch/vo-blue-2.mp3",
    at: 10.6,
    speech: [10.82, 14.44],
    text: "Twenty offices in Sandton that need a plumber, before your first coffee.",
  },
];

/** Where the employee's avatar sits in the bright world. */
export const AVATAR = { x: 200, y: 292, r: 58 };

/** The big flat Leads card. */
export const BOARD = {
  x: 860,
  y: 150,
  w: 940,
  h: 780,
  rowTop: 372,
  rowStep: 76,
};

export type Lead = { name: string; area: string; score: number };

/** Example businesses near Sandton, Johannesburg, that could need a plumber. */
export const LEADS: Lead[] = [
  { name: "Rosebank Auto Care", area: "Rosebank", score: 94 },
  { name: "Sandton Medical Suites", area: "Sandton", score: 92 },
  { name: "Grayston Office Park", area: "Sandton", score: 90 },
  { name: "Illovo Dental Studio", area: "Illovo", score: 88 },
  { name: "Morningside Clinic", area: "Morningside", score: 87 },
  { name: "Bryanston Fitness Club", area: "Bryanston", score: 85 },
  { name: "Rivonia Vet Hospital", area: "Rivonia", score: 83 },
];

export function rowY(i: number): number {
  return BOARD.rowTop + i * BOARD.rowStep;
}

/** Where a carrier ant settles: the owner spot at the left of its row. */
export function ownerSlot(i: number): Point {
  return { x: BOARD.x + 52, y: rowY(i) + 38 };
}

/** A carrier walks up from below the frame and curves into its row. */
export function carryPath(i: number): Path {
  const end = ownerSlot(i);
  return [
    { x: 760 + i * 26, y: 1160 },
    { x: 780 + i * 10, y: 1010 },
    { x: BOARD.x - 70, y: end.y + 40 },
    end,
  ];
}

export function carryStart(i: number): number {
  return BEAT.carryFrom + i * BEAT.carryEvery;
}

export function landsAt(i: number): number {
  return carryStart(i) + BEAT.carryDuration;
}

/** Leads found so far: one per landed carrier, then a quick count up to 20. */
export function foundCount(t: number): number {
  const landed = LEADS.filter((_, i) => t >= landsAt(i)).length;
  if (landed < LEADS.length) return landed;
  const rush = easeInOutCubic(progress(t, BEAT.countRushFrom, BEAT.countRush));
  return landed + Math.round((20 - LEADS.length) * rush);
}

/** Camera: wide for the intro, close on the rows while the ants deliver, wide again for "20 found". */
export const CAMERA = {
  focusX: BOARD.x + 140,
  focusY: 560,
  close: 1.26,
  inFrom: 4.9,
  inTo: 6.4,
  outFrom: 9.9,
  outTo: 11.4,
};

export function cameraScale(t: number): number {
  const zoomIn = easeInOutCubic(
    progress(t, CAMERA.inFrom, CAMERA.inTo - CAMERA.inFrom),
  );
  const zoomOut = easeInOutCubic(
    progress(t, CAMERA.outFrom, CAMERA.outTo - CAMERA.outFrom),
  );
  return 1 + (CAMERA.close - 1) * (zoomIn - zoomOut);
}
