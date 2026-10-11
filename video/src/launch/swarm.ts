import {
  clamp01,
  easeInOutCubic,
  lerpAngle,
  mulberry32,
  smoothstep,
} from "./math.ts";
import type { Point } from "./points.ts";

/** One colored river: every ant in the group bends through these two control points, give or take `spread`. */
export type Lane = { c1: Point; c2: Point; spread: number };

export type Ant = {
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  group: number;
  /** Seconds when the ant fades in on its letter. */
  appear: number;
  /** Seconds when it leaves its letter. */
  release: number;
  /** Seconds of flight. */
  duration: number;
  wobbleAmp: number;
  wobblePhase: number;
  /** Length in px while flying. */
  size: number;
};

export type AntState = {
  x: number;
  y: number;
  /** Radians; 0 points right, the way the brand mark faces. */
  angle: number;
  size: number;
  alpha: number;
  /** 0 = white (still a letter), 1 = its employee color. */
  toGroup: number;
  /** 0 = flying, 1 = settled into its place in the logo. */
  landed: number;
};

export type SwarmOptions = {
  seed: number;
  releaseAt: number;
  sweep: number;
  frameWidth: number;
  /** Seconds of flight: `min` plus up to `spread` more. Default 1.45 + 0.4. */
  flight?: { min: number; spread: number };
};

export function bezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  u: number,
): Point {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export function bezierTangent(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  u: number,
): Point {
  const v = 1 - u;
  const a = 3 * v * v;
  const b = 6 * v * u;
  const c = 3 * u * u;
  return {
    x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
    y: a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y),
  };
}

function byX(points: Point[]): number[] {
  return points
    .map((_, i) => i)
    .sort((a, b) => points[a].x - points[b].x || points[a].y - points[b].y);
}

/**
 * Pairs each letter point with a logo point and gives it a river. Lane `g`
 * takes the g-th vertical slice of the letters (left to right) and flies it
 * to the g-th vertical slice of the logo, so each employee color builds its
 * own part of the mark instead of the four colors mixing into mud. Inside a
 * slice, starts and ends are paired top to bottom.
 */
export function createAnts(
  starts: Point[],
  ends: Point[],
  lanes: Lane[],
  opts: SwarmOptions,
): Ant[] {
  if (starts.length !== ends.length) {
    throw new Error(
      `createAnts: ${starts.length} starts but ${ends.length} ends`,
    );
  }
  if (lanes.length === 0) throw new Error("createAnts: no lanes");
  const rand = mulberry32(opts.seed);
  const flightMin = opts.flight?.min ?? 1.45;
  const flightSpread = opts.flight?.spread ?? 0.4;
  const startOrder = byX(starts);
  const endOrder = byX(ends);
  const ants: Ant[] = [];
  lanes.forEach((lane, group) => {
    const lo = Math.floor((group * starts.length) / lanes.length);
    const hi = Math.floor(((group + 1) * starts.length) / lanes.length);
    const sliceStarts = startOrder
      .slice(lo, hi)
      .sort((a, b) => starts[a].y - starts[b].y);
    const sliceEnds = endOrder
      .slice(lo, hi)
      .sort((a, b) => ends[a].y - ends[b].y);
    const jitter = () => (rand() - 0.5) * 2 * lane.spread;
    sliceStarts.forEach((startIndex, k) => {
      const start = starts[startIndex];
      ants.push({
        start,
        end: ends[sliceEnds[k]],
        group,
        c1: { x: lane.c1.x + jitter(), y: lane.c1.y + jitter() },
        c2: { x: lane.c2.x + jitter(), y: lane.c2.y + jitter() },
        appear: opts.releaseAt - 0.15 + rand() * 0.05,
        release:
          opts.releaseAt +
          (start.x / opts.frameWidth) * opts.sweep +
          rand() * 0.12,
        duration: flightMin + rand() * flightSpread,
        wobbleAmp: 10 + rand() * 22,
        wobblePhase: rand() * Math.PI * 2,
        size: 18 + rand() * 7,
      });
    });
  });
  return ants;
}

/** Where one ant is at `t` seconds. Pure: no state, any order. */
export function antState(ant: Ant, t: number): AntState {
  const u = clamp01((t - ant.release) / ant.duration);
  const e = easeInOutCubic(u);
  const base = bezier(ant.start, ant.c1, ant.c2, ant.end, e);
  const tan = bezierTangent(ant.start, ant.c1, ant.c2, ant.end, e);
  const len = Math.hypot(tan.x, tan.y) || 1;
  const wobble =
    Math.sin(Math.PI * e) * ant.wobbleAmp * Math.sin(t * 7 + ant.wobblePhase);
  const heading = Math.atan2(tan.y, tan.x);
  const leaving = smoothstep(0, 0.08, u);
  const landing = smoothstep(0.82, 1, u);
  return {
    x: base.x + (-tan.y / len) * wobble,
    y: base.y + (tan.x / len) * wobble,
    angle: lerpAngle(lerpAngle(0, heading, leaving), 0, landing),
    size: ant.size * (0.62 + 0.38 * leaving) * (1 + 0.2 * landing),
    alpha: smoothstep(ant.appear, ant.appear + 0.15, t),
    toGroup: smoothstep(0, 0.25, u),
    landed: landing,
  };
}
