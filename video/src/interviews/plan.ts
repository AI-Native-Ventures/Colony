import type { Box } from "../launch/tall/frame.ts";

/** Who says a line: you, the owner hiring, or the employee in the interview. */
export type Speaker = "you" | "scout";

/** One spoken line: its words on screen and its voice file, with the file's length. */
export type ScriptLine = {
  id: string;
  speaker: Speaker;
  text: string;
  file: string;
  seconds: number;
};

/** An interview episode: who is interviewed, and the lines in order. */
export type InterviewScript = {
  name: string;
  role: string;
  lines: readonly ScriptLine[];
};

export type PlacedLine = ScriptLine & { at: number; end: number };

/** A question and the answer to it; the last question ("You're hired.") has none. */
export type Pair = { question: PlacedLine; answer: PlacedLine | null };

export type InterviewPlan = {
  lines: PlacedLine[];
  pairs: Pair[];
  /** When the HIRED stamp lands. */
  stampAt: number;
  /** The end card, in the launch film's close keys. */
  close: {
    dimFrom: number;
    dark: number;
    logoIn: number;
    name: number;
    tagline: number;
    earlyAt: number;
    urlAt: number;
  };
  seconds: number;
};

/** The candidate card: eyebrow, avatar, name and role. Frame pixels. */
export const CARD_BOX: Box = { x: 140, y: 360, w: 800, h: 480 };

/** Where the question and its answer sit, left of Instagram's buttons. */
export const CHAT_BOX: Box = { x: 72, y: 900, w: 876, h: 600 };

/** When the first question starts: after the candidate card is in. */
const FIRST = 1.3;
/** From a question's end to its answer, and from an answer to the next question. */
const BEFORE_ANSWER = 0.3;
const BEFORE_QUESTION = 0.6;
/** "You're hired." follows the last answer a little sooner: the decision is quick. */
const BEFORE_HIRED = 0.45;
/** How long the stamp holds before the end card. */
const STAMP_HOLD = 1.6;

/** Lines placed one after another, the stamp on the last word, then the end card. */
export function planInterview(script: InterviewScript): InterviewPlan {
  const lines: PlacedLine[] = [];
  let at = FIRST;
  script.lines.forEach((line, i) => {
    if (i > 0) {
      const last = i === script.lines.length - 1;
      at +=
        line.speaker === "scout"
          ? BEFORE_ANSWER
          : last
            ? BEFORE_HIRED
            : BEFORE_QUESTION;
    }
    lines.push({ ...line, at, end: at + line.seconds });
    at += line.seconds;
  });
  const pairs: Pair[] = [];
  for (const line of lines) {
    if (line.speaker === "you") pairs.push({ question: line, answer: null });
    else {
      const pair = pairs[pairs.length - 1];
      if (pair) pair.answer = line;
    }
  }
  const hired = lines[lines.length - 1];
  const stampAt = hired.end - 0.15;
  const dimFrom = stampAt + STAMP_HOLD;
  const close = {
    dimFrom,
    dark: dimFrom + 0.6,
    logoIn: dimFrom + 0.7,
    name: dimFrom + 0.9,
    tagline: dimFrom + 1.5,
    earlyAt: dimFrom + 2.4,
    urlAt: dimFrom + 3.0,
  };
  return { lines, pairs, stampAt, close, seconds: close.urlAt + 1.8 };
}

/**
 * Words broken into lines no wider than `max` (by `width`), first fit, so a
 * bubble can be as wide as its longest line instead of its widest allowance.
 * A word wider than `max` gets a line of its own.
 */
export function breakLines(
  words: readonly string[],
  width: (text: string) => number,
  max: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(next) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
