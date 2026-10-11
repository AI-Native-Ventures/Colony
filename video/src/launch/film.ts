/**
 * The full 30 second launch film, in seconds. Voice lines are cuts of the
 * Gemini "Aoede" read (public/launch/vo-*.mp3, see SOURCES.md); `at` is
 * where the cut starts in the film and `speech` is where the words are.
 */
export const FILM_SECONDS = 30;

/** Seconds into music draft B where it lifts; the logo flash sits on it. */
export const MUSIC_LIFT = 7.0;

export type Span = { start: number; end: number };

export const SCENE_ORDER = [
  "opening",
  "business",
  "team",
  "approve",
  "end",
] as const;
export type SceneId = (typeof SCENE_ORDER)[number];

export const SCENES: Record<SceneId, Span> = {
  opening: { start: 0, end: 9.3 },
  business: { start: 9.3, end: 13.3 },
  team: { start: 13.3, end: 17.9 },
  approve: { start: 17.9, end: 24.4 },
  end: { start: 24.4, end: 30 },
};

export type VoLine = {
  id: string;
  file: string;
  at: number;
  speech: readonly [number, number];
  text: string;
};

export const VO_LINES: VoLine[] = [
  {
    id: "l1",
    file: "launch/vo-l1.mp3",
    at: 0.3,
    speech: [0.5, 3.21],
    text: "Running a business means doing every job yourself.",
  },
  {
    id: "l2",
    file: "launch/vo-l2.mp3",
    at: 3.7,
    speech: [3.9, 4.73],
    text: "What if you had a team?",
  },
  {
    id: "l3",
    file: "launch/vo-l3.mp3",
    at: 6.85,
    speech: [7.05, 8.2],
    text: "Introducing Colony.",
  },
  {
    id: "l4a",
    file: "launch/vo-l4a.mp3",
    at: 9.5,
    speech: [9.7, 10.42],
    text: "Paste your website,",
  },
  {
    id: "l4b",
    file: "launch/vo-l4b.mp3",
    at: 13.4,
    speech: [13.5, 17.37],
    text: "and meet your AI employees: software that does office work for you.",
  },
  {
    id: "l5",
    file: "launch/vo-l5.mp3",
    at: 18.2,
    speech: [18.4, 20.95],
    text: "They do the work. Nothing goes out without your yes.",
  },
  {
    id: "l6",
    file: "launch/vo-l6.mp3",
    at: 24.7,
    speech: [24.9, 29.18],
    text: "Colony. Your business. Your AI employees. Early access is open.",
  },
];

export type Caption = { text: string; from: number; to: number };

/** Words on screen for the app scenes; the opening and end card draw their own. */
export const CAPTIONS: Caption[] = [
  { text: "Paste your website.", from: 9.6, to: 13.2 },
  { text: "Meet your AI employees.", from: 13.5, to: 17.8 },
  { text: "Software that does office work for you.", from: 14.6, to: 17.8 },
  { text: "Nothing goes out without your yes.", from: 19.0, to: 24.3 },
];

/** The cursor presses the first Approve on the word "yes". */
export const CLICK_AT = 20.75;
