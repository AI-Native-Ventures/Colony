import type { ScoutTask } from "../launch/wide/scout.ts";
import { SCOUT_CARD } from "../launch/wide/scout.ts";
import type { Rect } from "./approve.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 1, "Meet Scout", for Mahlangu Builders in Pretoria: film
 * seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP01_SECONDS = 37.5;

/** What the owner tells Scout, typed on the plan card. */
export const EP01_REQUEST = "More work from property developers this month.";

/** Scout's plan for the builder: one job each, short enough for the task cards. */
export const EP01_TASKS: readonly ScoutTask[] = [
  { who: "blue", text: "Find 15 developers in Pretoria" },
  { who: "amber", text: "Email and call each one" },
  { who: "pink", text: "Post our latest build" },
];

/** The owner's yes, bottom right of the plan card. */
export const EP01_APPROVE: Rect = {
  x: SCOUT_CARD.x + SCOUT_CARD.w - 48 - 280,
  y: SCOUT_CARD.y + SCOUT_CARD.h - 36 - 64,
  w: 280,
  h: 64,
};

export const EP01_BEATS: Beats = {
  hook: { start: 0, end: 4.15 },
  meet: { start: 4.15, end: 13.2 },
  work: { start: 13.2, end: 25.9 },
  yes: { start: 25.9, end: 29.6 },
  end: { start: 29.6, end: EP01_SECONDS },
};

export const EP01_LINES: EpisodeLine[] = [
  line(
    "ep01",
    "h1",
    "hook",
    "You're on site all day. Who's running the office?",
    [0.2, 3.47],
    [0.317, 3.332],
    0.35,
    false,
  ),
  line(
    "ep01",
    "m1",
    "meet",
    "Colony gives your business AI employees: AI agents that do the office work. Scout leads them. Scout is your chief of staff.",
    [3.79, 12.45],
    [3.924, 12.347],
    4.25,
  ),
  line(
    "ep01",
    "w1",
    "work",
    "Tell Scout what you want in one sentence: more work from property developers this month.",
    [12.46, 17.6],
    [12.56, 17.442],
    13.4,
  ),
  line(
    "ep01",
    "w2",
    "work",
    "Scout makes the plan and gives each employee their job.",
    [17.86, 20.9],
    [17.996, 20.757],
    19.0,
  ),
  line(
    "ep01",
    "w3",
    "work",
    "When the work comes back, Scout checks it.",
    [21.22, 23.5],
    [21.36, 23.364],
    22.95,
  ),
  line(
    "ep01",
    "y1",
    "yes",
    "Then it comes to you, and you say yes.",
    [23.61, 25.82],
    [23.746, 25.663],
    26.25,
  ),
  line(
    "ep01",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [26.23, 29.33],
    [26.37, 29.176],
    29.9,
    false,
  ),
  line(
    "ep01",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [29.4, 32.1],
    [29.531, 31.973],
    33.0,
    false,
  ),
];

/** Every moment on screen, set against the line it serves. */
export const EP01 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.25,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 3.45,
  stageTo: 4.15,
  avatarAt: 4.15,
  headlineAt: 4.4,
  sublineAt: 5.1,
  focusFrom: 13.0,
  cardIn: 9.0,
  requestFrom: 15.9,
  requestCps: 18,
  taskFrom: 19.3,
  taskEvery: 0.5,
  taskDuration: 0.9,
  checkAt: 23.9,
  approveIn: 25.3,
  cursorFrom: 26.4,
  click: 27.7,
  approvedAt: 27.9,
  closeFrom: 28.6,
  closeDark: 29.4,
  logoIn: 29.5,
  name: 29.8,
  tagline: 30.8,
  earlyAt: 33.0,
  urlAt: 34.6,
};
