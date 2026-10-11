import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 5, "Makes your posts", for Rise Bakery: film seconds. Voice cut
 * from one Aoede read (cut points in public/launch/SOURCES.md).
 */
export const EP05_SECONDS = 33;

/** What the owner tells the employee, typed on the posts card. */
export const EP05_REQUEST = "New sourdough this week, and the Saturday market.";

export const EP05_BEATS: Beats = {
  hook: { start: 0, end: 3.45 },
  meet: { start: 3.45, end: 8.2 },
  work: { start: 8.2, end: 20.9 },
  yes: { start: 20.9, end: 23.9 },
  end: { start: 23.9, end: EP05_SECONDS },
};

export const EP05_LINES: EpisodeLine[] = [
  line(
    "ep05",
    "h1",
    "hook",
    "When did you last post? Be honest.",
    [0.27, 2.85],
    [0.397, 2.705],
    0.35,
  ),
  line(
    "ep05",
    "m1",
    "meet",
    "Colony gives your business AI employees. This one makes your posts.",
    [3.1, 7.4],
    [3.227, 7.238],
    3.6,
  ),
  line(
    "ep05",
    "w1",
    "work",
    "Tell it what's happening this week: new sourdough, and the Saturday market.",
    [7.68, 11.35],
    [7.817, 11.204],
    8.35,
  ),
  line(
    "ep05",
    "w2",
    "work",
    "It writes the words and makes the pictures, in your bakery's style.",
    [11.5, 15.3],
    [11.631, 15.145],
    13.1,
  ),
  line(
    "ep05",
    "w3",
    "work",
    "Then it picks the best times to post.",
    [15.53, 17.55],
    [15.664, 17.406],
    17.95,
  ),
  line(
    "ep05",
    "y1",
    "yes",
    "You check them, and say yes.",
    [17.7, 19.3],
    [17.836, 19.1],
    21.3,
  ),
  line(
    "ep05",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [19.82, 22.75],
    [19.945, 22.606],
    24.5,
    false,
  ),
  line(
    "ep05",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [22.94, 25.7],
    [23.066, 25.532],
    27.6,
    false,
  ),
];

/** Every moment on screen, set against the line it serves. */
export const EP05 = {
  hookWordsAt: 0.1,
  hookHonestAt: 2.05,
  swarmFrom: 0,
  swarmBuilt: 2.3,
  stageFrom: 2.75,
  stageTo: 3.45,
  avatarAt: 3.45,
  headlineAt: 3.7,
  sublineAt: 4.4,
  focusFrom: 8.1,
  cardIn: 7.75,
  requestFrom: 8.6,
  requestCps: 16,
  carryFrom: 12.1,
  carryEvery: 0.5,
  carryDuration: 1.2,
  readyAt: 14.8,
  timesAt: 18.4,
  approveIn: 20.95,
  cursorFrom: 21.3,
  click: 22.35,
  scheduledAt: 22.55,
  closeFrom: 23.3,
  closeDark: 24.1,
  logoIn: 24.2,
  name: 24.45,
  tagline: 25.4,
  earlyAt: 27.6,
  urlAt: 28.9,
};
