import { mulberry32 } from "../math.ts";
import { type Point, pickPoints } from "../points.ts";
import { type Ant, createAnts, type Lane } from "../swarm.ts";
import { WIDE_W } from "./beat.ts";

export type RiverSpec = {
  /** Ant color as a CSS rgb() string. */
  color: string;
  seed: number;
  count: number;
  /** Where the ants start: x and y ranges. */
  from: { x0: number; x1: number; y0: number; y1: number };
  lane: Lane;
  /** The avatar the river curls into. */
  target: Point;
  startAt: number;
  /** The river fades into the avatar from here. */
  landAt: number;
  /** Seconds of extra delay per frame width the start sits to the right. Default 0.5. */
  sweep?: number;
  /** Seconds of flight per ant. Default 1.45 + up to 0.4. */
  flight?: { min: number; spread: number };
};

/** The ants of one river, paired with spots inside the avatar circle. Pure. */
export function riverAnts(spec: RiverSpec): Ant[] {
  const rand = mulberry32(spec.seed);
  const starts: Point[] = Array.from({ length: spec.count }, () => ({
    x: spec.from.x0 + rand() * (spec.from.x1 - spec.from.x0),
    y: spec.from.y0 + rand() * (spec.from.y1 - spec.from.y0),
  }));
  const pool: Point[] = [];
  for (let y = -48; y <= 48; y += 7) {
    for (let x = -48; x <= 48; x += 7) {
      if (x * x + y * y <= 48 * 48)
        pool.push({ x: spec.target.x + x, y: spec.target.y + y });
    }
  }
  return createAnts(starts, pickPoints(pool, spec.count, rand), [spec.lane], {
    seed: spec.seed + 1,
    releaseAt: spec.startAt,
    sweep: spec.sweep ?? 0.5,
    frameWidth: WIDE_W,
    flight: spec.flight,
  });
}
