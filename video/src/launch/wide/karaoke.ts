/**
 * How many words of `text` to show at `t`, spreading the words across the
 * speech window by length, so a word appears when its share of the line
 * starts and never before.
 */
export function wordsShown(
  text: string,
  speech: readonly [number, number],
  t: number,
): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (t < speech[0]) return 0;
  if (t >= speech[1]) return words.length;
  const total = words.reduce((sum, w) => sum + w.length + 1, 0);
  const elapsed = ((t - speech[0]) / (speech[1] - speech[0])) * total;
  let before = 0;
  let shown = 0;
  for (const word of words) {
    if (before > elapsed) break;
    shown++;
    before += word.length + 1;
  }
  return shown;
}
