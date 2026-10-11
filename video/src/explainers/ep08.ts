import type { HeroLook } from "../launch/wide/employees.ts";
import { SCOUT_LOOK } from "../launch/wide/employees.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 8, "Talk to your team", for Thandi's Kitchen in Durban: film
 * seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP08_SECONDS = 33.3;

/** What the owner types, right on the menu. */
export const EP08_REPLY = "Make the wedding menu vegetarian-friendly.";

/** The episode's own hero: the team's violet, titled with the episode. */
export const EP08_LOOK: HeroLook = {
  ...SCOUT_LOOK,
  title: ["Talk to", "your team."],
  subline: "A chat for each topic. Reply right on the work.",
  badge: "Chats",
  avatar: "person",
};

export const EP08_BEATS: Beats = {
  hook: { start: 0, end: 4.0 },
  meet: { start: 4.0, end: 9.3 },
  work: { start: 9.3, end: 22.4 },
  yes: { start: 22.4, end: 25.5 },
  end: { start: 25.5, end: EP08_SECONDS },
};

export const EP08_LINES: EpisodeLine[] = [
  line(
    "ep08",
    "h1",
    "hook",
    "No settings. No prompts. Just tell them.",
    [0.1, 3.42],
    [0.23, 3.091],
    0.35,
    false,
  ),
  line(
    "ep08",
    "m1",
    "meet",
    "In Colony, you talk to your AI employees the way you'd talk to people.",
    [3.62, 7.71],
    [3.748, 7.465],
    4.1,
  ),
  line(
    "ep08",
    "w1",
    "work",
    "Each topic gets its own chat: weddings, office lunches, the website.",
    [7.84, 12.79],
    [7.966, 12.41],
    9.4,
  ),
  line(
    "ep08",
    "w2",
    "work",
    "Want a change? Reply right on it: make the wedding menu vegetarian-friendly.",
    [13.05, 17.71],
    [13.179, 17.399],
    14.2,
  ),
  line(
    "ep08",
    "w3",
    "work",
    "The new menu comes back in the same place.",
    [17.9, 20.22],
    [18.035, 19.967],
    19.1,
  ),
  line(
    "ep08",
    "y1",
    "yes",
    "You say yes, and it's done.",
    [20.36, 22.15],
    [20.487, 21.781],
    22.7,
  ),
  line(
    "ep08",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [22.39, 25.47],
    [22.521, 25.18],
    25.6,
    false,
  ),
  line(
    "ep08",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [25.65, 28.45],
    [25.778, 28.245],
    28.6,
    false,
  ),
];

/** Every moment on screen, set against the line it serves. */
export const EP08 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.31,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 3.3,
  stageTo: 4.0,
  avatarAt: 4.0,
  headlineAt: 4.25,
  sublineAt: 4.95,
  focusFrom: 9.3,
  cardIn: 7.6,
  threadsAt: [11.55, 12.27, 13.35] as const,
  replyIn: 15.15,
  replyFrom: 16.6,
  replyCps: 20,
  backAt: 19.15,
  approveIn: 22.3,
  cursorFrom: 22.5,
  click: 23.15,
  approvedAt: 23.35,
  closeFrom: 24.3,
  closeDark: 25.1,
  logoIn: 25.2,
  name: 25.5,
  tagline: 26.55,
  earlyAt: 28.6,
  urlAt: 30.0,
};
