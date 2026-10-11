import { SITE_BAR, SITE_CARD } from "../launch/wide/bright.ts";
import type { Rect } from "./approve.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";
import { MO_NOW } from "./mo.ts";

/**
 * Explainer 6, "Keeps your website fresh", for Mo's Auto Repairs in Soweto:
 * film seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP06_SECONDS = 33.0;

/** What the owner tells the employee, typed under its hero. */
export const EP06_REQUEST = `A full service is now ${MO_NOW.service}, and we're open on Saturdays.`;

/** The owner's request, in a card under the employee. */
export const REQUEST_CARD: Rect = { x: 140, y: 740, w: 620, h: 170 };

/** The address in the browser bar is narrower than the film's, to leave room for Before, After and Approve. */
export const DOMAIN_WIDTH = 280;
/** Where the address pill ends: card padding, three dots, the film's 120 px gap. */
export const DOMAIN_END =
  SITE_CARD.x + 24 + 3 * 14 + 2 * 10 + 10 + 120 + DOMAIN_WIDTH;

const BAR_BUTTON_Y = SITE_CARD.y + (SITE_BAR - 44) / 2;
export const BAR_APPROVE: Rect = {
  x: SITE_CARD.x + SITE_CARD.w - 24 - 170,
  y: BAR_BUTTON_Y,
  w: 170,
  h: 44,
};
export const BAR_TOGGLE: Rect = {
  x: BAR_APPROVE.x - 12 - 220,
  y: BAR_BUTTON_Y,
  w: 220,
  h: 44,
};

/** The owner's pointer comes up from the bottom right to Approve. */
export const YES_FROM = { x: 1760, y: 1010 };

export const EP06_BEATS: Beats = {
  hook: { start: 0, end: 3.65 },
  meet: { start: 3.65, end: 8.4 },
  work: { start: 8.4, end: 21.0 },
  yes: { start: 21.0, end: 24.4 },
  end: { start: 24.4, end: EP06_SECONDS },
};

export const EP06_LINES: EpisodeLine[] = [
  line(
    "ep06",
    "h1",
    "hook",
    "Your prices went up. Your website didn't.",
    [0.16, 3.0],
    [0.287, 2.818],
    0.35,
    false,
  ),
  line(
    "ep06",
    "m1",
    "meet",
    "In Colony, this AI employee looks after your website.",
    [3.17, 6.5],
    [3.3, 6.286],
    4.0,
  ),
  line(
    "ep06",
    "w1",
    "work",
    "Tell it what changed: a full service is now fourteen fifty, and you're open on Saturdays.",
    [6.8, 12.03],
    [6.936, 11.822],
    8.6,
    `Tell it what changed: a full service is now ${MO_NOW.service}, and you're open on Saturdays.`,
  ),
  line(
    "ep06",
    "w2",
    "work",
    "It updates the page and shows you before and after.",
    [12.24, 15.14],
    [12.373, 14.943],
    14.5,
  ),
  line(
    "ep06",
    "y1",
    "yes",
    "Say yes, and it's live.",
    [15.25, 17.05],
    [15.381, 16.833],
    21.3,
  ),
  line(
    "ep06",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [17.35, 20.32],
    [17.485, 20.153],
    24.6,
    false,
  ),
  line(
    "ep06",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [20.36, 23.19],
    [20.496, 22.985],
    27.6,
    false,
  ),
];

/**
 * Every moment on screen, set against the line it serves. The website card
 * keeps the launch film's paint keys; `chipAt` is when the page goes live.
 */
export const EP06 = {
  hookWordsAt: -0.3,
  hookSublineAt: 1.66,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 2.95,
  stageTo: 3.65,
  avatarAt: 3.65,
  headlineAt: 3.9,
  sublineAt: 4.6,
  focusFrom: 8.4,
  siteIn: 6.8,
  requestIn: 8.4,
  requestFrom: 9.85,
  requestCps: 17,
  paintFrom: 14.6,
  paintDuration: 2.2,
  toggleIn: 16.9,
  beforeFrom: 17.3,
  beforeUntil: 18.5,
  approveIn: 20.9,
  cursorFrom: 21.0,
  click: 21.65,
  liveAt: 22.35,
  chipAt: 22.35,
  closeFrom: 23.3,
  closeDark: 24.1,
  logoIn: 24.2,
  name: 24.5,
  tagline: 25.6,
  earlyAt: 27.6,
  urlAt: 29.0,
};
