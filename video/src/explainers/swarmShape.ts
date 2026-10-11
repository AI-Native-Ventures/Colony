import type { Point } from "../launch/points.ts";

export type Side = "top" | "right" | "bottom" | "left";
const ALL: readonly Side[] = ["top", "right", "bottom", "left"];

/**
 * `n` points just outside the frame (30 to 120 px out), spread along the
 * chosen sides by length, so a swarm can fly in from off screen. `minX`
 * keeps starts on the top and bottom edges right of a column of words.
 */
export function edgeStarts(
  n: number,
  rand: () => number,
  frame: { w: number; h: number },
  sides: readonly Side[] = ALL,
  minX = 0,
): Point[] {
  const span = (s: Side) =>
    s === "top" || s === "bottom" ? frame.w - minX : frame.h;
  const total = sides.reduce((sum, s) => sum + span(s), 0);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    let d = rand() * total;
    const off = 30 + rand() * 90;
    let side = sides[sides.length - 1];
    for (const s of sides) {
      if (d < span(s)) {
        side = s;
        break;
      }
      d -= span(s);
    }
    if (side === "top") out.push({ x: minX + d, y: -off });
    else if (side === "bottom") out.push({ x: minX + d, y: frame.h + off });
    else if (side === "right") out.push({ x: frame.w + off, y: d });
    else out.push({ x: -off, y: d });
  }
  return out;
}
