import type { EmployeeId } from "../launch/wide/employees.ts";
import type { Rect } from "./approve.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 7, "Nothing goes out without your yes", for Sparkle Cleaning in
 * Fourways: film seconds. Voice cut from one Aoede read (cut points in
 * SOURCES.md).
 */
export const EP07_SECONDS = 37.0;

/** What waits for the owner, one row per employee. */
export const EP07_QUEUE: readonly {
  who: EmployeeId;
  title: string;
  kind: string;
}[] = [
  { who: "amber", title: "Reply to Nomsa's quote", kind: "Email" },
  { who: "pink", title: "2 posts for this week", kind: "Posts" },
  { who: "blue", title: "8 new leads in Fourways", kind: "Leads" },
];

/** The quote reply: the first draft, the owner's note, and the rewrite. */
export const EP07_DRAFT = {
  to: "Nomsa",
  context: "asked for a quote",
  subject: "Your cleaning quote",
  before:
    "Hi Nomsa, thank you so much for getting in touch with Sparkle Cleaning. We would be delighted to help with your home. Our standard clean for a three-bedroom house is R450 per visit, and we can come weekly or every two weeks. Please let us know which day suits you best.",
  after:
    "Hi Nomsa, a weekly clean of your three-bedroom home is R450 a visit, and we bring our own supplies. Shall we start on Tuesday?",
  /** The part of the rewrite the note asked for, marked once it is typed. */
  added: "we bring our own supplies",
  note: "Shorter, and mention we bring our own supplies.",
};

/** The review card, where the film's email card sits. */
export const REVIEW_CARD: Rect = { x: 860, y: 150, w: 940, h: 760 };
/** The owner's note, under the draft. */
export const NOTE_BOX: Rect = {
  x: REVIEW_CARD.x + 52,
  y: REVIEW_CARD.y + 556,
  w: REVIEW_CARD.w - 104,
  h: 84,
};
export const REVIEW_APPROVE: Rect = {
  x: REVIEW_CARD.x + REVIEW_CARD.w - 52 - 240,
  y: REVIEW_CARD.y + REVIEW_CARD.h - 36 - 64,
  w: 240,
  h: 64,
};

export const EP07_BEATS: Beats = {
  hook: { start: 0, end: 5.2 },
  meet: { start: 5.2, end: 10.6 },
  work: { start: 10.6, end: 22.8 },
  yes: { start: 22.8, end: 29.1 },
  end: { start: 29.1, end: EP07_SECONDS },
};

export const EP07_LINES: EpisodeLine[] = [
  line(
    "ep07",
    "h1",
    "hook",
    "An AI that emails your customers? Only if you say yes.",
    [0.08, 4.47],
    [0.205, 4.288],
    0.35,
    false,
  ),
  line(
    "ep07",
    "m1",
    "meet",
    "In Colony, your AI employees do the work, but everything comes to you first.",
    [4.52, 9.43],
    [4.65, 9.259],
    5.3,
  ),
  line(
    "ep07",
    "w1",
    "work",
    "Here's a reply to a customer who asked for a quote.",
    [9.46, 12.05],
    [9.593, 11.851],
    10.7,
    "Here's a reply to a customer who wants a quote.",
  ),
  line(
    "ep07",
    "w2",
    "work",
    "Not quite right? Just say so: shorter, and mention we bring our own supplies.",
    [12.35, 17.26],
    [12.484, 17.056],
    14.7,
  ),
  line(
    "ep07",
    "w3",
    "work",
    "It rewrites it in seconds.",
    [17.36, 19.05],
    [17.494, 18.846],
    19.95,
  ),
  line(
    "ep07",
    "y1",
    "yes",
    "When it's right, you say yes.",
    [19.15, 20.98],
    [19.287, 20.757],
    23.0,
  ),
  line(
    "ep07",
    "y2",
    "yes",
    "Then, and only then, it goes.",
    [21.16, 23.23],
    [21.291, 23.097],
    25.6,
  ),
  line(
    "ep07",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [23.24, 26.53],
    [23.356, 26.327],
    29.2,
    false,
  ),
  line(
    "ep07",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [26.6, 29.37],
    [26.734, 29.165],
    32.5,
    false,
  ),
];

/** Every moment on screen, set against the line it serves. */
export const EP07 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.87,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 4.5,
  stageTo: 5.2,
  avatarAt: 5.2,
  headlineAt: 5.45,
  sublineAt: 6.15,
  focusFrom: 10.6,
  cardIn: 6.9,
  queueFrom: 7.9,
  queueEvery: 0.35,
  openAt: 10.75,
  noteIn: 14.7,
  noteFrom: 16.8,
  noteCps: 20,
  rewriteAt: 20.0,
  rewriteCps: 60,
  approveIn: 22.6,
  cursorFrom: 22.9,
  click: 24.2,
  approvedAt: 24.4,
  sentAt: 26.95,
  closeFrom: 27.9,
  closeDark: 28.7,
  logoIn: 28.8,
  name: 29.1,
  tagline: 30.45,
  earlyAt: 32.5,
  urlAt: 33.75,
};

/** When queue row `i` arrives. */
export function queueRowAt(i: number, timing: typeof EP07): number {
  return timing.queueFrom + i * timing.queueEvery;
}
