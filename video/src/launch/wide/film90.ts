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
import { HOW, teamRowAt } from "./how.ts";
import type { RiverSpec } from "./riverAnts.ts";
import { employeeNode } from "./scout.ts";
import { approvedAt, YES_CARD, YES_ROWS, yesRowY } from "./yes.ts";

/**
 * The wide launch film, in film seconds. Planned at 90 s (hence the names);
 * the owner opened it up on 2026-10-11 so a stranger learns who it is for,
 * what Colony is and how it works before meeting the team. Voice: Aoede
 * reads (`launch/f90-*.mp3` and, once recorded, `launch/f120-*.mp3`; cut
 * points in SOURCES.md).
 */
export const FILM90_SECONDS = 119;

export const ACT_ORDER = [
  "weight",
  "colony",
  "how",
  "scout",
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
  weight: { start: 0, end: 16.0 },
  colony: { start: 16.0, end: 31.5 },
  how: { start: 31.5, end: 40.0 },
  scout: { start: 40.0, end: 48.0 },
  blue: { start: 48.0, end: 56.6 },
  amber: { start: 56.6, end: 70.1 },
  pink: { start: 70.1, end: 76.5 },
  green: { start: 76.5, end: 83.1 },
  yes: { start: 83.1, end: 95.9 },
  dayBack: { start: 95.9, end: 108.4 },
  close: { start: 108.4, end: 119 },
};

export type Line90 = {
  id: string;
  act: ActId;
  /** What the voice says. */
  text: string;
  /** What the subtitle shows, when it differs (a web address). */
  caption?: string;
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
  read: "f90" | "f130" | "f140" = "f90",
  caption?: string,
): Line90 {
  const lead = spoken[0] - cut[0];
  return {
    id,
    act,
    text,
    caption,
    file: `launch/${read}-${id}.mp3`,
    cut,
    at: startsAt - lead,
    speech: [startsAt, startsAt + (spoken[1] - spoken[0])],
  };
}

/**
 * `spoken` is where the words sit in the source read; the last number is
 * where they land in the film. "f130" lines are the 2026-10-11 Aoede read
 * through the Gemini API; "f90" lines are the earlier read.
 */
export const LINES: Line90[] = [
  line(
    "n01",
    "weight",
    "You started a business to do the work you love.",
    [0.05, 2.4],
    [0.159, 2.26],
    1.0,
    "f130",
  ),
  line(
    "n02",
    "weight",
    "Then came everything else. Finding customers, emails, posts, the website.",
    [2.45, 7.85],
    [2.595, 7.711],
    4.9,
    "f130",
  ),
  line(
    "n03",
    "weight",
    "And there is never enough of you.",
    [8.2, 10.0],
    [8.343, 9.852],
    10.9,
    "f130",
  ),
  line(
    "n04",
    "colony",
    "Introducing: Colony.",
    [10.4, 11.7],
    [10.522, 11.552],
    17.3,
    "f130",
  ),
  line(
    "n05",
    "colony",
    "Colony is an app that gives your business a team of AI employees.",
    [11.75, 15.5],
    [11.873, 15.346],
    19.6,
    "f130",
  ),
  line(
    "n06",
    "colony",
    "An AI employee is software that does office work for you, like a person on your team.",
    [15.55, 19.7],
    [15.673, 19.55],
    25.8,
    "f130",
  ),
  line(
    "n07",
    "how",
    "Paste your website. Colony reads it, and hires your team.",
    [20.15, 23.0],
    [20.285, 22.88],
    33.9,
    "f130",
  ),
  line(
    "s01",
    "scout",
    "Meet Scout, your chief of staff. Scout plans the work, gives each employee their job, and checks it before it reaches you.",
    [23.35, 29.5],
    [23.476, 29.35],
    40.7,
    "f130",
  ),
  line(
    "l08",
    "blue",
    "This one finds customers.",
    [17.93, 19.55],
    [18.061, 19.394],
    49.2,
  ),
  line(
    "l09",
    "blue",
    "Twenty offices in Sandton that need a plumber, before your first coffee.",
    [19.68, 23.55],
    [19.817, 23.399],
    53.0,
  ),
  line(
    "a01",
    "amber",
    "This one sells for you. It emails each of them, like this one,",
    [0.1, 4.9],
    [0.233, 4.84],
    57.35,
    "f140",
  ),
  line(
    "a03",
    "amber",
    "asking an office park to make you their on-call plumber.",
    [4.9, 8.2],
    [4.987, 7.932],
    62.2,
    "f140",
  ),
  line(
    "a04",
    "amber",
    "Then it calls, and books the meeting.",
    [8.3, 11.45],
    [8.501, 10.99],
    65.75,
    "f140",
  ),
  line(
    "l11",
    "pink",
    "This one makes your posts. Three, ready for Instagram.",
    [27.17, 30.7],
    [27.303, 30.545],
    70.6,
  ),
  line(
    "l12",
    "green",
    "And this one keeps your website up to date.",
    [31.18, 33.86],
    [31.311, 33.711],
    77.1,
  ),
  line(
    "l13",
    "yes",
    "Everything they make comes to you first.",
    [34.28, 36.28],
    [34.409, 36.133],
    83.9,
  ),
  line(
    "l14",
    "yes",
    "Nothing goes out without your yes.",
    [36.47, 38.47],
    [36.6, 38.319],
    88.5,
  ),
  line(
    "l15",
    "dayBack",
    "So while you're out doing the work you love, your team keeps the business moving.",
    [38.65, 42.62],
    [38.782, 42.464],
    96.9,
  ),
  line(
    "c01",
    "close",
    "Colony. AI employees for your business.",
    [33.95, 36.7],
    [34.05, 36.518],
    110.5,
    "f130",
  ),
  line(
    "c02",
    "close",
    "Early access is open at colony dot global.",
    [36.85, 39.5],
    [36.975, 39.327],
    113.9,
    "f130",
    "Early access is open at colony.global.",
  ),
];

/** The cursor presses Approve as "yes" is said. */
export const CLICK90 = 89.9;

/** Blue beat timing in film seconds (same fields as the proof beat's BEAT). */
export const BLUE90: BlueTiming = {
  riverFrom: 47.2,
  brightFrom: 47.6,
  brightTo: 48.6,
  avatarAt: 48.4,
  headlineAt: 49.2,
  sublineAt: 49.75,
  focusFrom: 50.4,
  boardIn: 49.6,
  carryFrom: 50.6,
  carryEvery: 0.32,
  carryDuration: 1.3,
  countRushFrom: 53.9,
  countRush: 1.0,
};

export const BLUE90_CAMERA: CameraTiming = {
  inFrom: 50.4,
  inTo: 51.4,
  outFrom: 53.6,
  outTo: 54.6,
};

/** The sales employee writes the partnership email (its ant walks the line like a pen), then calls. */
export const AMBER90 = {
  riverFrom: 56.15,
  avatarAt: 57.1,
  headlineAt: 57.35,
  sublineAt: 57.85,
  cardIn: 57.6,
  focusFrom: 58.2,
  walkFrom: 57.7,
  typeFrom: 58.3,
  typeCps: 45,
  returnSeconds: 0.32,
  countRushFrom: 64.1,
  countRush: 0.6,
  callIn: 65.55,
  connectAt: 66.25,
  bubble1At: 66.55,
  bubble2At: 67.95,
  bookedAt: 68.95,
};

/** Pink's ants carry three posts into the grid. */
export const PINK90 = {
  riverFrom: 69.55,
  avatarAt: 70.45,
  headlineAt: 70.65,
  sublineAt: 71.15,
  gridIn: 70.9,
  focusFrom: 71.5,
  carryFrom: 71.4,
  carryEvery: 0.5,
  carryDuration: 1.2,
  readyAt: 73.85,
};

/** Green's ant walks across the website and repaints it. */
export const GREEN90 = {
  riverFrom: 75.65,
  avatarAt: 76.55,
  headlineAt: 77.15,
  sublineAt: 77.65,
  siteIn: 77.4,
  focusFrom: 78.1,
  paintFrom: 78.3,
  paintDuration: 2.2,
  chipAt: 80.7,
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
  amber: AMBER90.bookedAt + 0.5,
  pink: PINK90.readyAt + 0.6,
  green: GREEN90.chipAt + 0.6,
};

/** The owner's inbox: everything waits here for a yes. */
export const YES90 = {
  avatarAt: 83.95,
  headlineAt: 84.15,
  sublineAt: 84.65,
  focusFrom: 87.9,
  cardIn: 84.2,
  carryFrom: 84.4,
  carryEvery: 0.35,
  carryDuration: 1.1,
  cursorFrom: 88.2,
  click: CLICK90,
  cascadeEvery: 0.14,
  burst: 1.3,
  outcomesAt: 92.1,
};

/** The owner's day on a running clock. */
export const DAY90 = {
  titleAt: 95.8,
  clockFrom: 96.3,
  clockTo: 106.3,
  summaryAt: 106.6,
};

/** The close: the bright world folds back into the dark, the ants return to the logo, name and address. */
export const CLOSE90 = {
  dimFrom: 108.6,
  dark: 109.6,
  logoIn: 110.2,
  name: 110.4,
  tagline: 111.8,
  earlyAt: 114.2,
  urlAt: 115.3,
};

/** Scout, the chief of staff, hands out today's work. */
export const SCOUT90 = {
  avatarAt: 40.4,
  headlineAt: 40.6,
  sublineAt: 41.2,
  focusFrom: 42.2,
  cardIn: 40.7,
  taskFrom: 42.4,
  taskEvery: 0.5,
  taskDuration: 0.9,
  checkAt: 45.4,
  doneAt: 46.9,
};

/** One long bright canvas: a panel per employee, then the inbox, then the day. */
export const PANEL_ORDER = ["how", "scout", ...TEAM, "yes", "day"] as const;
export type PanelId = (typeof PANEL_ORDER)[number];

export function panelX(id: PanelId): number {
  return PANEL_ORDER.indexOf(id) * WIDE_W;
}

/** Which panel each act happens on. */
export const ACT_PANEL: Partial<Record<ActId, PanelId>> = {
  how: "how",
  scout: "scout",
  blue: "blue",
  amber: "amber",
  pink: "pink",
  green: "green",
  yes: "yes",
  dayBack: "day",
};

/** The camera glides from one panel to the next. */
export const PANS: readonly { to: PanelId; start: number; end: number }[] = [
  { to: "scout", start: 39.4, end: 40.25 },
  { to: "blue", start: 47.2, end: 48.05 },
  { to: "amber", start: 56.1, end: 57.0 },
  { to: "pink", start: 69.5, end: 70.35 },
  { to: "green", start: 75.6, end: 76.45 },
  { to: "yes", start: 83.0, end: 83.85 },
  { to: "day", start: 94.8, end: 95.65 },
];

/** When each panel's first thing appears. */
export const PANEL_START: Record<PanelId, number> = {
  how: HOW.avatarAt,
  scout: SCOUT90.avatarAt,
  blue: BLUE90.avatarAt,
  amber: AMBER90.avatarAt,
  pink: PINK90.avatarAt,
  green: GREEN90.avatarAt,
  yes: YES90.avatarAt,
  day: DAY90.titleAt,
};

/** When each panel's work on screen is finished. */
export const PANEL_DONE: Record<PanelId, number> = {
  how: teamRowAt(TEAM.length - 1, HOW) + 0.6,
  scout: SCOUT90.doneAt,
  ...BEAT_DONE,
  yes: Math.max(
    YES90.click + 0.1 + 3 * YES90.cascadeEvery + YES90.burst,
    YES90.outcomesAt + 3 * 0.15 + 0.6,
  ),
  day: DAY90.summaryAt + 1,
};

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
    count: 160,
    from: {
      x0: panelX("scout") + employeeNode(0).x - 30,
      x1: panelX("scout") + employeeNode(0).x + 30,
      y0: employeeNode(0).y - 30,
      y1: employeeNode(0).y + 30,
    },
    lane: {
      c1: { x: panelX("scout") + 2000, y: 80 },
      c2: { x: panelX("blue") - 120, y: 40 },
      spread: 130,
    },
    target: { x: panelX("blue") + AVATAR.x, y: AVATAR.y },
    startAt: BLUE90.riverFrom,
    landAt: BLUE90.avatarAt,
    sweep: 0,
    flight: { min: 0.9, spread: 0.3 },
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

/** On Approve, each card's work streams out to the right as a burst of its employee's ants. */
export const BURSTS90: RiverSpec[] = YES_ROWS.map((row, i) => {
  const x = panelX("yes");
  const y = yesRowY(i);
  const start = approvedAt(i, YES90) + 0.02;
  return {
    color: TONES[row.who].rgb,
    seed: 7901 + i * 17,
    count: 56,
    from: {
      x0: x + YES_CARD.x + 110,
      x1: x + YES_CARD.x + 700,
      y0: y + 14,
      y1: y + 78,
    },
    lane: {
      c1: { x: x + 1560, y: y - 140 },
      c2: { x: x + 2060, y: y - 60 },
      spread: 110,
    },
    target: { x: x + 2400, y: y - 110 },
    startAt: start,
    landAt: start + 1.05,
    sweep: 0,
    flight: { min: 0.75, spread: 0.35 },
  };
});

/** Where the logo lands at the close, screen pixels. */
export const CLOSE_LOGO = {
  cx: 960,
  cy: 330,
  width: 340,
  height: 340 * (309 / 466),
};
