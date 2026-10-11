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
import { HOW, teamAvatarSpot, teamRowAt } from "./how.ts";
import type { RiverSpec } from "./riverAnts.ts";
import { approvedAt, YES_CARD, YES_ROWS, yesRowY } from "./yes.ts";

/**
 * The wide launch film, in film seconds. Planned at 90 s (hence the names);
 * the owner opened it up on 2026-10-11 so a stranger learns who it is for,
 * what Colony is and how it works before meeting the team. Voice: Aoede
 * reads (`launch/f90-*.mp3` and, once recorded, `launch/f120-*.mp3`; cut
 * points in SOURCES.md).
 */
export const FILM90_SECONDS = 109;

export const ACT_ORDER = [
  "weight",
  "colony",
  "how",
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
  colony: { start: 16.0, end: 33.0 },
  how: { start: 33.0, end: 43.0 },
  blue: { start: 43.0, end: 51.6 },
  amber: { start: 51.6, end: 58.2 },
  pink: { start: 58.2, end: 64.6 },
  green: { start: 64.6, end: 71.2 },
  yes: { start: 71.2, end: 84.0 },
  dayBack: { start: 84.0, end: 96.5 },
  close: { start: 96.5, end: 109 },
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
  /** Not recorded yet: timed from an estimate, plays no audio. */
  pending?: boolean;
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

/** A line still to be recorded: `seconds` is an estimate at Aoede's pace. */
function pendingLine(
  id: string,
  act: ActId,
  text: string,
  startsAt: number,
  seconds: number,
  caption?: string,
): Line90 {
  return {
    id,
    act,
    text,
    caption,
    file: `launch/f120-${id}.mp3`,
    cut: [0, seconds + 0.3],
    at: startsAt - 0.13,
    speech: [startsAt, startsAt + seconds],
    pending: true,
  };
}

/** `spoken` is where the words sit in the source read; the last number is where they land in the film. */
export const LINES: Line90[] = [
  pendingLine(
    "n01",
    "weight",
    "You started a business to do the work you love.",
    0.8,
    3.2,
  ),
  pendingLine(
    "n02",
    "weight",
    "Then came everything else. Finding customers, emails, posts, the website.",
    4.9,
    4.6,
  ),
  line(
    "l02",
    "weight",
    "And there is never enough of you.",
    [3.5, 5.9],
    [3.632, 5.759],
    10.4,
  ),
  line(
    "l04",
    "colony",
    "Introducing: Colony.",
    [0.11, 2.0],
    [0.242, 1.852],
    17.3,
  ),
  pendingLine(
    "n05",
    "colony",
    "Colony is an app that gives your business a team of AI employees.",
    20.0,
    4.0,
  ),
  pendingLine(
    "n06",
    "colony",
    "An AI employee is software that does office work for you, like a person on your team.",
    25.8,
    5.2,
  ),
  pendingLine(
    "n07",
    "how",
    "Paste your website. Colony reads it, and hires your team.",
    35.0,
    3.6,
  ),
  pendingLine("n08", "how", "Meet your team.", 40.9, 1.0),
  line(
    "l08",
    "blue",
    "This one finds customers.",
    [17.93, 19.55],
    [18.061, 19.394],
    44.2,
  ),
  line(
    "l09",
    "blue",
    "Twenty offices in Sandton that need a plumber, before your first coffee.",
    [19.68, 23.55],
    [19.817, 23.399],
    48.0,
  ),
  line(
    "l10",
    "amber",
    "This one writes to each of them, in your words.",
    [23.97, 26.83],
    [24.102, 26.677],
    52.3,
  ),
  line(
    "l11",
    "pink",
    "This one makes your posts. Three, ready for Instagram.",
    [27.17, 30.7],
    [27.303, 30.545],
    58.7,
  ),
  line(
    "l12",
    "green",
    "And this one keeps your website up to date.",
    [31.18, 33.86],
    [31.311, 33.711],
    65.2,
  ),
  line(
    "l13",
    "yes",
    "Everything they make comes to you first.",
    [34.28, 36.28],
    [34.409, 36.133],
    72.0,
  ),
  line(
    "l14",
    "yes",
    "Nothing goes out without your yes.",
    [36.47, 38.47],
    [36.6, 38.319],
    76.6,
  ),
  line(
    "l15",
    "dayBack",
    "So while you're out doing the work you love, your team keeps the business moving.",
    [38.65, 42.62],
    [38.782, 42.464],
    85.0,
  ),
  pendingLine(
    "c01",
    "close",
    "Colony. AI employees for your business.",
    98.8,
    2.6,
  ),
  pendingLine(
    "c02",
    "close",
    "Early access is open at colony dot AI native dot ventures.",
    102.2,
    3.8,
    "Early access is open at colony.ainative.ventures.",
  ),
];

/** When "Meet your team." has been said, on the how-it-works panel. */
const NEW_TEAM_SAID = 41.9;

/** The cursor presses Approve as "yes" is said. */
export const CLICK90 = 78.0;

/** Blue beat timing in film seconds (same fields as the proof beat's BEAT). */
export const BLUE90: BlueTiming = {
  riverFrom: 42.3,
  brightFrom: 42.6,
  brightTo: 43.6,
  avatarAt: 43.4,
  headlineAt: 44.2,
  sublineAt: 44.75,
  focusFrom: 45.4,
  boardIn: 44.6,
  carryFrom: 45.6,
  carryEvery: 0.32,
  carryDuration: 1.3,
  countRushFrom: 48.9,
  countRush: 1.0,
};

export const BLUE90_CAMERA: CameraTiming = {
  inFrom: 45.4,
  inTo: 46.4,
  outFrom: 48.6,
  outTo: 49.6,
};

/** Amber writes the email to Thabo while its ant walks the line like a pen. */
export const AMBER90 = {
  riverFrom: 51.15,
  avatarAt: 52.1,
  headlineAt: 52.35,
  sublineAt: 52.85,
  cardIn: 52.6,
  focusFrom: 53.2,
  walkFrom: 52.7,
  typeFrom: 53.3,
  typeCps: 44,
  returnSeconds: 0.36,
  countRushFrom: 56.45,
  countRush: 0.7,
};

/** Pink's ants carry three posts into the grid. */
export const PINK90 = {
  riverFrom: 57.65,
  avatarAt: 58.55,
  headlineAt: 58.75,
  sublineAt: 59.25,
  gridIn: 59,
  focusFrom: 59.6,
  carryFrom: 59.5,
  carryEvery: 0.5,
  carryDuration: 1.2,
  readyAt: 61.95,
};

/** Green's ant walks across the website and repaints it. */
export const GREEN90 = {
  riverFrom: 63.75,
  avatarAt: 64.65,
  headlineAt: 65.25,
  sublineAt: 65.75,
  siteIn: 65.5,
  focusFrom: 66.2,
  paintFrom: 66.4,
  paintDuration: 2.2,
  chipAt: 68.8,
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

/** The owner's inbox: everything waits here for a yes. */
export const YES90 = {
  avatarAt: 72.05,
  headlineAt: 72.25,
  sublineAt: 72.75,
  focusFrom: 76,
  cardIn: 72.3,
  carryFrom: 72.5,
  carryEvery: 0.35,
  carryDuration: 1.1,
  cursorFrom: 76.3,
  click: CLICK90,
  cascadeEvery: 0.14,
  burst: 1.3,
  outcomesAt: 80.2,
};

/** The owner's day on a running clock. */
export const DAY90 = {
  titleAt: 83.9,
  clockFrom: 84.4,
  clockTo: 94.4,
  summaryAt: 94.7,
};

/** The close: the bright world folds back into the dark, the ants return to the logo, name and address. */
export const CLOSE90 = {
  dimFrom: 96.7,
  dark: 97.7,
  logoIn: 98.3,
  name: 98.5,
  tagline: 99.9,
  earlyAt: 102.3,
  urlAt: 103.4,
};

/** One long bright canvas: a panel per employee, then the inbox, then the day. */
export const PANEL_ORDER = ["how", ...TEAM, "yes", "day"] as const;
export type PanelId = (typeof PANEL_ORDER)[number];

export function panelX(id: PanelId): number {
  return PANEL_ORDER.indexOf(id) * WIDE_W;
}

/** Which panel each act happens on. */
export const ACT_PANEL: Partial<Record<ActId, PanelId>> = {
  how: "how",
  blue: "blue",
  amber: "amber",
  pink: "pink",
  green: "green",
  yes: "yes",
  dayBack: "day",
};

/** The camera glides from one panel to the next. */
export const PANS: readonly { to: PanelId; start: number; end: number }[] = [
  { to: "blue", start: 42.3, end: 43.15 },
  { to: "amber", start: 51.1, end: 52.0 },
  { to: "pink", start: 57.6, end: 58.45 },
  { to: "green", start: 63.7, end: 64.55 },
  { to: "yes", start: 71.1, end: 71.95 },
  { to: "day", start: 82.9, end: 83.75 },
];

/** When each panel's first thing appears. */
export const PANEL_START: Record<PanelId, number> = {
  how: HOW.avatarAt,
  blue: BLUE90.avatarAt,
  amber: AMBER90.avatarAt,
  pink: PINK90.avatarAt,
  green: GREEN90.avatarAt,
  yes: YES90.avatarAt,
  day: DAY90.titleAt,
};

/** When each panel's work on screen is finished. */
export const PANEL_DONE: Record<PanelId, number> = {
  how: Math.max(teamRowAt(TEAM.length - 1, HOW) + 0.6, NEW_TEAM_SAID + 0.3),
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
      x0: panelX("how") + teamAvatarSpot(0).x - 34,
      x1: panelX("how") + teamAvatarSpot(0).x + 34,
      y0: teamAvatarSpot(0).y - 34,
      y1: teamAvatarSpot(0).y + 34,
    },
    lane: {
      c1: { x: panelX("how") + 1500, y: -40 },
      c2: { x: panelX("blue") - 60, y: 120 },
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
