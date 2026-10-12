/** One voice line: a sentence cut from a read, and its caption when it differs. */
export type VoiceLine = { id: string; text: string; caption?: string };

/** A stretch of a video: its lines, and the least time it stays on screen. */
export type TimedBeat = {
  id: string;
  lines: readonly VoiceLine[];
  minSeconds: number;
};

export type Timeline = {
  seconds: number;
  beats: Array<{ id: string; from: number; to: number }>;
  lines: Array<VoiceLine & { beat: string; at: number; end: number }>;
};

/** Breath before a beat's first line, between lines, and after its last. */
export const LEAD = 0.5;
export const GAP = 0.45;
export const TAIL = 1.2;

/**
 * Lay the beats end to end: each one's lines are read in order, and the beat
 * lasts as long as its voice needs, never less than its minimum. The beats
 * stretch to fit the voice, never the other way.
 */
export function timeline(
  beats: readonly TimedBeat[],
  voiceSeconds: (lineId: string) => number,
): Timeline {
  const out: Timeline = { seconds: 0, beats: [], lines: [] };
  let t = 0;
  for (const beat of beats) {
    let at = t + LEAD;
    for (const [i, line] of beat.lines.entries()) {
      if (i > 0) at += GAP;
      const end = at + voiceSeconds(line.id);
      out.lines.push({ ...line, beat: beat.id, at, end });
      at = end;
    }
    const to = Math.max(t + beat.minSeconds, at + TAIL);
    out.beats.push({ id: beat.id, from: t, to });
    t = to;
  }
  out.seconds = t;
  return out;
}

/** About how long Aoede takes to read `text`: 2.6 words a second, until the voice is cut. */
export function estimateSeconds(text: string): number {
  return text.split(/\s+/).filter(Boolean).length / 2.6;
}
