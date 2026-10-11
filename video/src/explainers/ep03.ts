import type { Lead } from "../launch/wide/beat.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 3, "Finds customers", for Bright Plumbing in Sandton: film
 * seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP03_SECONDS = 33.3;

/** What the owner asks for, typed under the Leads title. */
export const EP03_REQUEST = "Office parks in Sandton";

/**
 * Office parks around Sandton that could sign a plumbing contract, each
 * with the reason it fits. Made-up names on real street and suburb names.
 */
export const EP03_LEADS: readonly Lead[] = [
  {
    name: "Grayston Office Park",
    area: "Sandton",
    score: 94,
    why: "120 offices on one site",
  },
  {
    name: "Maude Street Offices",
    area: "Sandton",
    score: 92,
    why: "No plumber on contract",
  },
  {
    name: "Rivonia Corner Park",
    area: "Rivonia",
    score: 90,
    why: "Built 1994, older pipes",
  },
  {
    name: "West Street Chambers",
    area: "Sandton",
    score: 88,
    why: "New tenants moving in",
  },
  {
    name: "Fredman Drive Park",
    area: "Sandton",
    score: 87,
    why: "Two buildings, 300 staff",
  },
  {
    name: "Katherine Court",
    area: "Sandton",
    score: 85,
    why: "Kitchens on every floor",
  },
  {
    name: "Wierda Valley Offices",
    area: "Wierda Valley",
    score: 83,
    why: "Refit planned this year",
  },
];

/** The rows the owner ticks, top to bottom, and when. */
export const EP03_PICKS: readonly { row: number; at: number }[] = [
  { row: 0, at: 17.3 },
  { row: 1, at: 17.55 },
  { row: 2, at: 17.8 },
  { row: 4, at: 18.15 },
  { row: 6, at: 18.5 },
];

export const EP03_BEATS: Beats = {
  hook: { start: 0, end: 4.4 },
  meet: { start: 4.4, end: 8.2 },
  work: { start: 8.2, end: 19.2 },
  yes: { start: 19.2, end: 25.8 },
  end: { start: 25.8, end: EP03_SECONDS },
};

export const EP03_LINES: EpisodeLine[] = [
  line(
    "ep03",
    "h1",
    "hook",
    "You fix pipes all day. Who's finding your next customer?",
    [0.13, 3.77],
    [0.263, 3.567],
    0.35,
    false,
  ),
  line(
    "ep03",
    "m1",
    "meet",
    "In Colony, an AI employee finds customers for you.",
    [4.11, 7.78],
    [4.244, 7.576],
    4.5,
  ),
  line(
    "ep03",
    "w1",
    "work",
    "Tell it who you want: office parks in Sandton.",
    [8.08, 11.12],
    [8.214, 10.916],
    8.3,
  ),
  line(
    "ep03",
    "w2",
    "work",
    "It searches, checks each one, and brings you twenty, with why each one fits.",
    [11.56, 16.29],
    [11.695, 16.092],
    11.9,
  ),
  line(
    "ep03",
    "w3",
    "work",
    "You pick the ones you like.",
    [16.64, 17.92],
    [16.771, 17.723],
    17.15,
  ),
  line(
    "ep03",
    "y1",
    "yes",
    "Your sales employee writes to them next.",
    [18.3, 20.39],
    [18.435, 20.187],
    19.75,
  ),
  line(
    "ep03",
    "y2",
    "yes",
    "Nothing goes out without your yes.",
    [20.62, 22.48],
    [20.753, 22.28],
    22.65,
  ),
  line(
    "ep03",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [23.04, 25.84],
    [23.169, 25.644],
    25.9,
    false,
  ),
  line(
    "ep03",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [25.98, 28.67],
    [26.116, 28.47],
    28.7,
    false,
  ),
];

/**
 * Every moment on screen, set against the line it serves. The Leads card
 * keeps the launch film's carry and count keys; the blue employee hands
 * the five picks to the amber one, whose Approve waits with the pointer
 * resting on it.
 */
export const EP03 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.2,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 3.7,
  stageTo: 4.4,
  avatarAt: 4.4,
  headlineAt: 4.65,
  sublineAt: 5.35,
  focusFrom: 8.2,
  boardIn: 7.6,
  requestFrom: 9.63,
  requestCps: 17,
  carryFrom: 11.9,
  carryEvery: 0.22,
  carryDuration: 1.2,
  countRushFrom: 14.45,
  countRush: 0.5,
  reasonsAt: 15.05,
  reasonsEvery: 0.1,
  tickCursorFrom: 16.7,
  heroUntil: 19.2,
  amberAvatarAt: 19.65,
  amberHeadlineAt: 19.9,
  amberSublineAt: 20.55,
  handoffIn: 19.8,
  chipFrom: 20.4,
  chipEvery: 0.12,
  chipFlight: 0.8,
  approveIn: 22.7,
  restFrom: 22.75,
  restAt: 23.7,
  closeFrom: 24.6,
  closeDark: 25.4,
  logoIn: 25.5,
  name: 25.8,
  tagline: 26.5,
  earlyAt: 28.7,
  urlAt: 29.9,
};
