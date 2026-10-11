/** The part of `full` typed by `t` seconds, typing from `start` at `cps` characters a second. */
export function typedText(
  full: string,
  t: number,
  start: number,
  cps: number,
): string {
  if (t <= start) return "";
  const count = Math.min(full.length, Math.floor((t - start) * cps));
  return full.slice(0, count);
}
