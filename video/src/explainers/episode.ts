import type { BeatLine } from "../launch/wide/beat.ts";

/** The five beats every explainer moves through, in order. */
export type BeatId = "hook" | "meet" | "work" | "yes" | "end";
export const BEAT_ORDER: readonly BeatId[] = [
  "hook",
  "meet",
  "work",
  "yes",
  "end",
];

export type Span = { start: number; end: number };
export type Beats = Record<BeatId, Span>;

export type EpisodeLine = BeatLine & {
  beat: BeatId;
  /** Seconds in the source read this file was cut from. */
  cut: readonly [number, number];
  /** False when the words are already on screen as big type: no subtitle. */
  captioned: boolean;
};

/**
 * A voice line cut from one Aoede read. `cut` and `spoken` are seconds in the
 * read; `startsAt` is the film second the words start. `caption` is what the
 * subtitle shows when it differs from the words, or false for no subtitle.
 */
export function line(
  episode: string,
  id: string,
  beat: BeatId,
  text: string,
  cut: readonly [number, number],
  spoken: readonly [number, number],
  startsAt: number,
  caption?: string | false,
): EpisodeLine {
  const lead = spoken[0] - cut[0];
  return {
    id,
    beat,
    text,
    caption: typeof caption === "string" ? caption : undefined,
    captioned: caption !== false,
    cut,
    file: `explainers/${episode}-${id}.mp3`,
    at: startsAt - lead,
    speech: [startsAt, startsAt + (spoken[1] - spoken[0])],
  };
}

/** Longest a caption lingers after its words, when no line follows soon (1.8 s: Aoede reads a nine-word line in under 2 s). */
const HOLD = 1.8;
/** How long the last caption stays after its words. */
const LAST_HOLD = 0.7;

/**
 * When line `i`'s caption leaves: it stays until just before the next line
 * starts, up to HOLD seconds after its own words, so a fast voice still
 * leaves time to read.
 */
export function captionUntil(lines: readonly EpisodeLine[], i: number): number {
  const own = lines[i].speech[1];
  const next = lines[i + 1];
  if (!next) return own + LAST_HOLD;
  return Math.min(next.speech[0] - 0.05, own + HOLD);
}

/** Everything wrong with an episode's timeline, in plain words; empty when it is sound. */
export function timelineProblems(
  beats: Beats,
  lines: readonly EpisodeLine[],
  seconds: number,
): string[] {
  const out: string[] = [];
  if (beats.hook.start !== 0) out.push("hook must start at 0");
  for (let i = 1; i < BEAT_ORDER.length; i++) {
    const prev = beats[BEAT_ORDER[i - 1]];
    const cur = beats[BEAT_ORDER[i]];
    if (Math.abs(cur.start - prev.end) > 1e-6) {
      out.push(
        `${BEAT_ORDER[i]} starts at ${cur.start}, not where ${BEAT_ORDER[i - 1]} ends (${prev.end})`,
      );
    }
  }
  if (Math.abs(beats.end.end - seconds) > 1e-6) {
    out.push(`end beat stops at ${beats.end.end}, film is ${seconds}`);
  }
  const hook = lines.find((l) => l.beat === "hook");
  if (!hook || hook.speech[0] > 1.0) {
    out.push("hook must be voiced within the first second");
  }
  lines.forEach((l, i) => {
    const span = beats[l.beat];
    if (l.speech[0] < span.start || l.speech[1] > span.end) {
      out.push(`${l.id} is spoken outside ${l.beat}`);
    }
    if (l.at < 0) out.push(`${l.id} file starts before the film`);
    const words = (l.caption ?? l.text).split(/\s+/).length;
    if (l.captioned && captionUntil(lines, i) - l.speech[0] < words / 3 + 0.5) {
      out.push(`${l.id} is up too briefly to read`);
    }
    const next = lines[i + 1];
    if (next && next.speech[0] < l.speech[1] + 0.15) {
      out.push(`${l.id} runs into ${next.id}`);
    }
  });
  return out;
}
