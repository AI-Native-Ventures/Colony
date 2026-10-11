import { GETTING_STARTED, type HeroLook } from "../launch/wide/employees.ts";
import { BUSINESS_CARD } from "../launch/wide/how.ts";
import type { Rect } from "./approve.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 2, "Your team in a minute", for Studio Nala in Rosebank: film
 * seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP02_SECONDS = 36.7;

/** The salon's address, pasted into the website field. */
export const EP02_WEBSITE = "studionala.co.za";

/** What Colony reads off the salon's website, one chip each, in the order they are said. */
export const EP02_FACTS: readonly string[] = [
  "Hair salon",
  "Rosebank",
  "Cuts, colour and braids",
  "Open six days",
];

/** The team rows sit higher than the film's, so the owner's yes fits under them. */
export const EP02_LAYOUT = { top: 170, step: 124 };

/** The owner's yes, under the last team row, right-aligned with the row chips. */
export const EP02_HIRE: Rect = {
  x: BUSINESS_CARD.x + BUSINESS_CARD.w - 52 - 280,
  y: BUSINESS_CARD.y + 664,
  w: 280,
  h: 72,
};

/** The episode's own hero: the getting-started violet, titled with the episode. */
export const EP02_LOOK: HeroLook = {
  ...GETTING_STARTED,
  title: ["Your team", "in a minute."],
  subline: "Paste your website. Colony reads it and hires your team.",
};

export const EP02_BEATS: Beats = {
  hook: { start: 0, end: 4.3 },
  meet: { start: 4.3, end: 9.2 },
  work: { start: 9.2, end: 25.3 },
  yes: { start: 25.3, end: 29.3 },
  end: { start: 29.3, end: EP02_SECONDS },
};

export const EP02_LINES: EpisodeLine[] = [
  line(
    "ep02",
    "h1",
    "hook",
    "Hiring takes weeks. This takes a minute.",
    [0.15, 3.6],
    [0.273, 3.459],
    0.35,
    false,
  ),
  line(
    "ep02",
    "m1",
    "meet",
    "Colony is an app that gives your business a team of AI employees.",
    [3.81, 7.4],
    [3.942, 7.165],
    4.4,
  ),
  line(
    "ep02",
    "w1",
    "work",
    "Paste your website.",
    [7.6, 8.8],
    [7.727, 8.484],
    9.3,
  ),
  line(
    "ep02",
    "w2",
    "work",
    "Colony reads it: a hair salon in Rosebank, cuts, colour and braids, open six days.",
    [9.14, 14.7],
    [9.271, 14.408],
    10.9,
  ),
  line(
    "ep02",
    "w3",
    "work",
    "Then it hires your team: one to find customers, one to sell, one for your posts, one for your website, and Scout to lead them.",
    [15.12, 23.2],
    [15.251, 22.843],
    16.5,
  ),
  line(
    "ep02",
    "y1",
    "yes",
    "Nothing starts until you say yes.",
    [23.67, 25.85],
    [23.802, 25.613],
    25.4,
  ),
  line(
    "ep02",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [26.02, 28.9],
    [26.144, 28.691],
    29.4,
    false,
  ),
  line(
    "ep02",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [29.08, 31.687],
    [29.207, 31.6],
    32.25,
    false,
  ),
];

/**
 * Every moment on screen, set against the line it serves. The website card
 * keeps the launch film's keys: `continueClick` is when it turns to the team,
 * on "Then it hires your team", with no button pressed.
 */
export const EP02 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.2,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 3.6,
  stageTo: 4.3,
  avatarAt: 4.3,
  headlineAt: 4.55,
  sublineAt: 5.25,
  focusFrom: 9.2,
  cardIn: 8.2,
  cursorFrom: 9.4,
  pasteAt: 9.55,
  readClick: 11.15,
  factFrom: 12.2,
  factEvery: 1.0,
  continueClick: 17.0,
  teamAt: 18.3,
  teamEvery: 1.1,
  scoutAt: 23.25,
  approveIn: 24.3,
  yesCursorFrom: 25.5,
  click: 26.85,
  approvedAt: 27.05,
  closeFrom: 28.1,
  closeDark: 28.9,
  logoIn: 29.0,
  name: 29.3,
  tagline: 30.35,
  earlyAt: 32.25,
  urlAt: 33.45,
};
