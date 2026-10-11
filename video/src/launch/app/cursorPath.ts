import { easeInOutCubic, progress } from "../math.ts";

export type CursorKey = { at: number; x: number; y: number };

/** Where the pointer is at `t`, gliding between keyframes (content coordinates). */
export function cursorAt(
  keys: readonly CursorKey[],
  t: number,
): { x: number; y: number } {
  if (t <= keys[0].at) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.at) {
      const e = easeInOutCubic(progress(t, a.at, b.at - a.at));
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
}
