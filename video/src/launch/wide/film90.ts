import type { Span } from "../film.ts";
import { easeInOutCubic, progress } from "../math.ts";
import {
  AVATAR,
  type BlueTiming,
  type CameraTiming,
  WIDE_H,
  WIDE_W,
} from "./beat.ts";
import { type EmployeeId, TEAM, TONES } from "./employees.ts";
import type { RiverSpec } from "./riverAnts.ts";

/**
 * The 90 second wide launch film, in film seconds. Voice: one Aoede read of
 * the full script (`launch/f90-*.mp3`, cut points in SOURCES.md) plus a
 * clearer separate take of "Introducing: Colony."
 */
export const FILM90_SECONDS = 90;

export const ACT_ORDER = [
  "weight",
  "colony",
  "blue",
  "amber",
  "pink",
  "green",
  "yes",
  "dayBack",
  "close",
] as const;
export type ActId = (typeof ACT_ORDER)[number];

export const ACTS: Record<ActId, Span> = {
  weight: { start: 0, end: 13.6 },
  colony: { start: 13.6, end: 26.0 },
  blue: { start: 26.0, end: 34.6 },
  amber: { start: 34.6, end: 41.2 },
  pink: { start: 41.2, end: 47.6 },
  green: { start: 47.6, end: 54.2 },
  yes: { start: 54.2, end: 67.0 },
  dayBack: { start: 67.0, end: 79.5 },
  close: { start: 79.5, end: 90 },
};

export type Line90 = {
  id: string;
  act: ActId;
  text: string;
  file: string;
  /** Seconds in the source read this file was cut from. */
  cut: readonly [number, number];
  /** Film second the file starts. */
  at: number;
  /** Film seconds the words are spoken. */
  speech: readonly [number, number];
};

function line(
  id: string,
  act: ActId,
  text: string,
  cut: readonly [number, number],
  spoken: readonly [number, number],
  startsAt: number,
): Line90 {
  const lead = spoken[0] - cut[0];
  return {
    id,
    act,
    text,
    file: `launch/f90-${id}.mp3`,
    cut,
    at: startsAt - lead,
    speech: [startsAt, startsAt + (spoken[1] - spoken[0])],
  };
}

/** `spoken` is where the words sit in the source read; the last number is where they land in the film. */
export const LINES: Line90[] = [
  line(
    "l01",
    "weight",
    "Running a business means doing every job yourself.",
    [0, 3.2],
    [0, 3.077],
    0.8,
  ),
  line(
    "l02",
    "weight",
    "And there is never enough of you.",
    [3.5, 5.9],
    [3.632, 5.759],
    5.6,
  ),
  line(
    "l03",
    "weight",
    "What if you had a team?",
    [6.24, 7.89],
    [6.372, 7.745],
    11.6,
  ),
  line(
    "l04",
    "colony",
    "Introducing: Colony.",
    [0.11, 2.0],
    [0.242, 1.852],
    16.0,
  ),
  line(
    "l05",
    "colony",
    "Your business. Your AI employees.",
    [10.23, 13.15],
    [10.363, 12.994],
    19.0,
  ),
  line(
    "l06",
    "colony",
    "AI employees are software that does office work for you.",
    [13.28, 16.26],
    [13.415, 16.111],
    22.3,
  ),
  line("l07", "colony", "Meet yours.", [16.68, 17.52], [16.814, 17.372], 25.3),
  line(
    "l08",
    "blue",
    "This one finds customers.",
    [17.93, 19.55],
    [18.061, 19.394],
    27.2,
  ),
  line(
    "l09",
    "blue",
    "Twenty offices in Sandton that need a plumber, before your first coffee.",
    [19.68, 23.55],
    [19.817, 23.399],
    31.0,
  ),
  line(
    "l10",
    "amber",
    "This one writes to each of them, in your words.",
    [23.97, 26.83],
    [24.102, 26.677],
    35.3,
  ),
  line(
    "l11",
    "pink",
    "This one makes your posts. Three, ready for Instagram.",
    [27.17, 30.7],
    [27.303, 30.545],
    41.7,
  ),
  line(
    "l12",
    "green",
    "And this one keeps your website up to date.",
    [31.18, 33.86],
    [31.311, 33.711],
    48.2,
  ),
  line(
    "l13",
    "yes",
    "Everything they make comes to you first.",
    [34.28, 36.28],
    [34.409, 36.133],
    55.0,
  ),
  line(
    "l14",
    "yes",
    "Nothing goes out without your yes.",
    [36.47, 38.47],
    [36.6, 38.319],
    59.6,
  ),
  line(
    "l15",
    "dayBack",
    "So while you're out doing the work you love, your team keeps the business moving.",
    [38.65, 42.62],
    [38.782, 42.464],
    68.0,
  ),
  line("l16", "close", "Colony.", [43.08, 43.83], [43.21, 43.684], 82.0),
  line(
    "l17",
    "close",
    "Your business. Your AI employees.",
    [44.05, 46.26],
    [44.183, 46.108],
    83.2,
  ),
  line(
    "l18",
    "close",
    "Early access is open.",
    [46.43, 48.0],
    [46.56, 47.841],
    86.0,
  ),
];

/** The cursor presses Approve as "yes" is said. */
export const CLICK90 = 61.0;

/** Blue beat timing in film seconds (same fields as the proof beat's BEAT). */
export const BLUE90: BlueTiming = {
  riverFrom: 24.9,
  brightFrom: 25.6,
  brightTo: 26.6,
  avatarAt: 26.4,
  headlineAt: 27.2,
  sublineAt: 27.75,
  focusFrom: 28.4,
  boardIn: 27.6,
  carryFrom: 28.6,
  carryEvery: 0.32,
  carryDuration: 1.3,
  countRushFrom: 31.9,
  countRush: 1.0,
};

export const BLUE90_CAMERA: CameraTiming = {
  inFrom: 28.4,
  inTo: 29.4,
  outFrom: 31.6,
  outTo: 32.6,
};

/** Amber writes the email to Thabo while its ant walks the line like a pen. */
export const AMBER90 = {
  riverFrom: 34.15,
  avatarAt: 35.1,
  headlineAt: 35.35,
  sublineAt: 35.85,
  cardIn: 35.6,
  focusFrom: 36.2,
  walkFrom: 35.7,
  typeFrom: 36.3,
  typeCps: 44,
  returnSeconds: 0.36,
  countRushFrom: 39.45,
  countRush: 0.7,
};

/** Pink's ants carry three posts into the grid. */
export const PINK90 = {
  riverFrom: 40.65,
  avatarAt: 41.55,
  headlineAt: 41.75,
  sublineAt: 42.25,
  gridIn: 42.0,
  focusFrom: 42.6,
  carryFrom: 42.5,
  carryEvery: 0.5,
  carryDuration: 1.2,
  readyAt: 44.95,
};

/** Green's ant walks across the website and repaints it. */
export const GREEN90 = {
  riverFrom: 46.75,
  avatarAt: 47.65,
  headlineAt: 48.25,
  sublineAt: 48.75,
  siteIn: 48.5,
  focusFrom: 49.2,
  paintFrom: 49.4,
  paintDuration: 2.2,
  chipAt: 51.8,
};

/** The hero timing every employee shares. */
export type HeroTiming = {
  riverFrom: number;
  avatarAt: number;
  headlineAt: number;
  sublineAt: number;
  focusFrom: number;
};

export const TIMING90: Record<EmployeeId, HeroTiming> = {
  blue: BLUE90,
  amber: AMBER90,
  pink: PINK90,
  green: GREEN90,
};

/** When each employee's work on screen is finished. */
export const BEAT_DONE: Record<EmployeeId, number> = {
  blue: BLUE90.countRushFrom + BLUE90.countRush,
  amber: AMBER90.countRushFrom + AMBER90.countRush,
  pink: PINK90.readyAt + 0.6,
  green: GREEN90.chipAt + 0.6,
};

/** Each employee has a panel on one long bright canvas, a frame width apart. */
export function panelX(id: EmployeeId): number {
  return TEAM.indexOf(id) * WIDE_W;
}

/** The camera glides from one employee to the next. */
export const PANS: readonly { to: EmployeeId; start: number; end: number }[] = [
  { to: "amber", start: 34.1, end: 35.0 },
  { to: "pink", start: 40.6, end: 41.45 },
  { to: "green", start: 46.7, end: 47.55 },
];

/** How far along the long canvas the camera is at film time `t`, in px. */
export function panX(t: number): number {
  let from = 0;
  for (const pan of PANS) {
    const to = panelX(pan.to);
    if (t < pan.end) {
      const e = easeInOutCubic(progress(t, pan.start, pan.end - pan.start));
      return from + (to - from) * e;
    }
    from = to;
  }
  return from;
}

/** Each employee arrives as a river of its color curling into its avatar (long canvas px). */
export const RIVERS90: Record<EmployeeId, RiverSpec> = {
  blue: {
    color: TONES.blue.rgb,
    seed: 7101,
    count: 220,
    from: { x0: -320, x1: -40, y0: 640, y1: 1020 },
    lane: { c1: { x: 1500, y: 1180 }, c2: { x: 1250, y: -160 }, spread: 170 },
    target: { x: AVATAR.x, y: AVATAR.y },
    startAt: BLUE90.riverFrom,
    landAt: BLUE90.avatarAt,
  },
  amber: employeeRiver("amber", 7301, {
    from: { x0: 820, x1: 1500, y0: WIDE_H + 40, y1: WIDE_H + 200 },
    lane: { c1: { x: 1450, y: 520 }, c2: { x: 560, y: 20 }, spread: 140 },
  }),
  pink: employeeRiver("pink", 7501, {
    from: { x0: 1000, x1: 1700, y0: -220, y1: -60 },
    lane: { c1: { x: 1500, y: 980 }, c2: { x: 260, y: 820 }, spread: 140 },
  }),
  green: employeeRiver("green", 7701, {
    from: { x0: 100, x1: 700, y0: WIDE_H + 40, y1: WIDE_H + 200 },
    lane: { c1: { x: 1500, y: 900 }, c2: { x: 980, y: -120 }, spread: 140 },
  }),
};

function employeeRiver(
  id: EmployeeId,
  seed: number,
  shape: Pick<RiverSpec, "from" | "lane">,
): RiverSpec {
  const x = panelX(id);
  const timing = TIMING90[id];
  return {
    color: TONES[id].rgb,
    seed,
    count: 140,
    from: {
      x0: shape.from.x0 + x,
      x1: shape.from.x1 + x,
      y0: shape.from.y0,
      y1: shape.from.y1,
    },
    lane: {
      c1: { x: shape.lane.c1.x + x, y: shape.lane.c1.y },
      c2: { x: shape.lane.c2.x + x, y: shape.lane.c2.y },
      spread: shape.lane.spread,
    },
    target: { x: AVATAR.x + x, y: AVATAR.y },
    startAt: timing.riverFrom,
    landAt: timing.avatarAt,
    sweep: 0,
    flight: { min: 0.9, spread: 0.3 },
  };
}
