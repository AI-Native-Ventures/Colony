import type { Call } from "../launch/wide/call.ts";
import { EMAIL_CARD, type Email } from "../launch/wide/email.ts";
import type { Rect } from "./approve.ts";
import { type Beats, type EpisodeLine, line } from "./episode.ts";

/**
 * Explainer 4, "Sells for you", for Golden Hour Photography in Cape Town:
 * film seconds. Voice cut from one Aoede read (cut points in SOURCES.md).
 */
export const EP04_SECONDS = 33.2;

/** The pitch to a wedding venue: be its go-to photographer. Made-up venue. */
export const EP04_EMAIL: Email = {
  to: "Megan",
  company: "Oak Hill Estate",
  subject: "Your go-to wedding photographer",
  lines: [
    "Hi Megan,",
    "Golden Hour Photography shoots weddings",
    "across the Winelands. We'd love to be your",
    "go-to photographer. Could we meet next week?",
  ],
};

/** The venue's answer, under the email. */
export const EP04_REPLY = {
  label: "Megan replied the next day",
  text: "Lovely! Can you call me tomorrow?",
};

/** Where the reply sits: inside the email card, under the last line. */
export const REPLY_NOTE: Rect = {
  x: EMAIL_CARD.x + 52,
  y: EMAIL_CARD.y + 636,
  w: EMAIL_CARD.w - 104,
  h: 104,
};

export const EP04_CALL: Call = {
  name: "Megan",
  company: "Oak Hill Estate",
  lines: [
    {
      who: "us",
      text: "Hi Megan, it's Golden Hour Photography, calling about your weddings.",
    },
    { who: "them", text: "Friday at eleven works for us." },
  ],
  booked: "Meeting booked: Fri 11:00",
};

/** The next emails, waiting under the employee for the owner's yes. */
export const EP04_NEXT = {
  title: "19 more emails",
  subtitle: "To wedding venues, in your words",
};

/** The owner's pointer comes up from the bottom of the frame to Approve. */
export const YES_FROM = { x: 1100, y: 1010 };

export const EP04_BEATS: Beats = {
  hook: { start: 0, end: 3.95 },
  meet: { start: 3.95, end: 8.2 },
  work: { start: 8.2, end: 21.3 },
  yes: { start: 21.3, end: 25.2 },
  end: { start: 25.2, end: EP04_SECONDS },
};

export const EP04_LINES: EpisodeLine[] = [
  line(
    "ep04",
    "h1",
    "hook",
    "The best clients won't find you. So go to them.",
    [0.11, 3.27],
    [0.237, 3.067],
    0.35,
    false,
  ),
  line(
    "ep04",
    "m1",
    "meet",
    "In Colony, this AI employee sells for you.",
    [3.49, 6.6],
    [3.619, 6.424],
    4.05,
  ),
  line(
    "ep04",
    "w1",
    "work",
    "It writes to wedding venues, offering to be their go-to photographer.",
    [6.67, 10.18],
    [6.8, 10.011],
    8.4,
  ),
  line(
    "ep04",
    "w2",
    "work",
    "When one replies,",
    [10.23, 11.33],
    [10.363, 11.258],
    13.6,
  ),
  line(
    "ep04",
    "w3",
    "work",
    "It calls and books the meeting.",
    [11.33, 12.9],
    [11.42, 12.702],
    15.8,
  ),
  line(
    "ep04",
    "y1",
    "yes",
    "Every email waits for your yes.",
    [13.45, 15.71],
    [13.581, 15.512],
    21.6,
  ),
  line(
    "ep04",
    "e1",
    "end",
    "Colony. AI employees for your business.",
    [16.07, 19.2],
    [16.2, 19.007],
    25.3,
    false,
  ),
  line(
    "ep04",
    "e2",
    "end",
    "Early access is open at colony dot global.",
    [19.42, 22.27],
    [19.552, 22.069],
    28.4,
    false,
  ),
];

/**
 * Every moment on screen, set against the line it serves. The email and
 * call cards keep the launch film's keys; the reply sits between them.
 */
export const EP04 = {
  hookWordsAt: -0.3,
  hookSublineAt: 2.2,
  swarmFrom: -0.5,
  swarmBuilt: 1.75,
  stageFrom: 3.25,
  stageTo: 3.95,
  avatarAt: 3.95,
  headlineAt: 4.2,
  sublineAt: 4.9,
  focusFrom: 8.2,
  cardIn: 7.0,
  walkFrom: 7.9,
  typeFrom: 8.7,
  typeCps: 45,
  returnSeconds: 0.32,
  countRushFrom: 12.9,
  countRush: 0.6,
  sentAt: 13.6,
  replyAt: 13.9,
  callIn: 16.0,
  connectAt: 16.6,
  bubble1At: 16.8,
  bubble2At: 19.0,
  bookedAt: 20.5,
  yesCardIn: 20.9,
  approveIn: 21.6,
  cursorFrom: 21.9,
  click: 23.15,
  approvedAt: 23.35,
  closeFrom: 24.0,
  closeDark: 24.8,
  logoIn: 24.9,
  name: 25.2,
  tagline: 26.35,
  earlyAt: 28.4,
  urlAt: 29.7,
};
