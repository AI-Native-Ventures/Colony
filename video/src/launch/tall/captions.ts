/** Characters in one caption row at 46 px, keyword padding included, inside the caption box. */
export const ROW_CHARS = 28;

/** A piece of a caption: words `from` to `to` (exclusive), shown as one or two rows. */
export type Chunk = { from: number; to: number; rows: string[] };

/**
 * Splits a caption into chunks of at most two rows of at most `rowChars`
 * characters, breaking between words. A word longer than a row gets a row
 * of its own.
 */
export function captionChunks(text: string, rowChars: number): Chunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  const rows: { from: number; to: number; text: string }[] = [];
  let row: string[] = [];
  let start = 0;
  words.forEach((word, i) => {
    const longer = row.length ? `${row.join(" ")} ${word}` : word;
    if (row.length && longer.length > rowChars) {
      rows.push({ from: start, to: i, text: row.join(" ") });
      row = [word];
      start = i;
    } else {
      row.push(word);
    }
  });
  if (row.length)
    rows.push({ from: start, to: words.length, text: row.join(" ") });
  const chunks: Chunk[] = [];
  for (let r = 0; r < rows.length; r += 2) {
    const pair = rows.slice(r, r + 2);
    chunks.push({
      from: pair[0].from,
      to: pair[pair.length - 1].to,
      rows: pair.map((p) => p.text),
    });
  }
  return chunks;
}

/** Which chunk is on screen once `shown` words have been said: the one holding the latest word. */
export function chunkAt(chunks: readonly Chunk[], shown: number): number {
  const word = Math.max(0, shown - 1);
  const k = chunks.findIndex((c) => word >= c.from && word < c.to);
  return k < 0 ? chunks.length - 1 : k;
}
