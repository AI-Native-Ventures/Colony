import { type Box, CAPTION_BOX } from "./frame.ts";

/** Characters in one caption row at 46 px, keyword padding included, inside the caption box. */
export const ROW_CHARS = 26;

/** How a tall film's captions look: type size and weight, the box they sit in, characters in a row. */
export type CaptionLook = {
  size: number;
  weight: number;
  box: Box;
  rowChars: number;
};

/** The Reels film's captions. */
export const FILM_CAPTIONS: CaptionLook = {
  size: 46,
  weight: 700,
  box: CAPTION_BOX,
  rowChars: ROW_CHARS,
};

/**
 * The explainers' captions on the Reels frame: about 1.6 times the film's,
 * a few words at a time, centred above Instagram's caption and left of its
 * buttons (owner, 2026-10-12: "the captions are only on a small part of the
 * screen").
 */
export const BIG_CAPTIONS: CaptionLook = {
  size: 74,
  weight: 800,
  box: { x: 132, y: 1322, w: 816, h: 190 },
  rowChars: 16,
};

/** A piece of a caption: words `from` to `to` (exclusive), shown as one or two rows. */
export type Chunk = { from: number; to: number; rows: string[] };

/**
 * The rows for a group of words: one row if it fits, otherwise the most even
 * two rows that fit. A single word longer than a row is allowed a row of its
 * own. Null when the words do not fit in two rows.
 */
function rowsFor(words: readonly string[], rowChars: number): string[] | null {
  const one = words.join(" ");
  if (one.length <= rowChars || words.length === 1) return [one];
  let best: string[] | null = null;
  let longest = Number.POSITIVE_INFINITY;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(" ");
    const b = words.slice(k).join(" ");
    const fitA = a.length <= rowChars || k === 1;
    const fitB = b.length <= rowChars || k === words.length - 1;
    if (!fitA || !fitB) continue;
    const m = Math.max(a.length, b.length);
    if (m < longest) {
      longest = m;
      best = [a, b];
    }
  }
  return best;
}

/** The fewest chunks that fit, filling each as far as it goes. */
function greedyGroups(words: readonly string[], rowChars: number): number[][] {
  const groups: number[][] = [];
  let group: number[] = [];
  words.forEach((_, i) => {
    const trial = [...group, i];
    if (
      group.length &&
      !rowsFor(
        trial.map((j) => words[j]),
        rowChars,
      )
    ) {
      groups.push(group);
      group = [i];
    } else {
      group = trial;
    }
  });
  if (group.length) groups.push(group);
  return groups;
}

/**
 * Splits `words` into `k` runs, each fitting two rows, with the longest run as
 * short as it can be, so no chunk is left holding a lone word. Null if no
 * such split exists.
 */
function evenRuns(
  words: readonly string[],
  k: number,
  rowChars: number,
): [number, number][] | null {
  const n = words.length;
  const cost = (i: number, j: number) => {
    const run = words.slice(i, j);
    return rowsFor(run, rowChars)
      ? run.join(" ").length
      : Number.POSITIVE_INFINITY;
  };
  const best = Array.from({ length: k + 1 }, () =>
    new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY),
  );
  const cut = Array.from({ length: k + 1 }, () =>
    new Array<number>(n + 1).fill(-1),
  );
  best[0][0] = 0;
  for (let c = 1; c <= k; c++) {
    for (let j = 1; j <= n; j++) {
      for (let i = c - 1; i < j; i++) {
        const v = Math.max(best[c - 1][i], cost(i, j));
        if (v < best[c][j]) {
          best[c][j] = v;
          cut[c][j] = i;
        }
      }
    }
  }
  if (!Number.isFinite(best[k][n])) return null;
  const runs: [number, number][] = [];
  let j = n;
  for (let c = k; c >= 1; c--) {
    const i = cut[c][j];
    runs.unshift([i, j]);
    j = i;
  }
  return runs;
}

/**
 * Splits a caption into chunks of at most two rows of at most `rowChars`
 * characters, breaking between words: as few chunks as fit, the words spread
 * evenly across them, and each chunk's two rows as even as they can be.
 */
export function captionChunks(text: string, rowChars: number): Chunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  const greedy = greedyGroups(words, rowChars);
  const runs =
    evenRuns(words, greedy.length, rowChars) ??
    greedy.map((g): [number, number] => [g[0], g[g.length - 1] + 1]);
  return runs.map(([from, to]) => ({
    from,
    to,
    rows: rowsFor(words.slice(from, to), rowChars) ?? [
      words.slice(from, to).join(" "),
    ],
  }));
}

/** Which chunk is on screen once `shown` words have been said: the one holding the latest word. */
export function chunkAt(chunks: readonly Chunk[], shown: number): number {
  const word = Math.max(0, shown - 1);
  const k = chunks.findIndex((c) => word >= c.from && word < c.to);
  return k < 0 ? chunks.length - 1 : k;
}
