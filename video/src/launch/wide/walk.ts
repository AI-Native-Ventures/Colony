import { clamp01, smoothstep } from "../math.ts";
import type { Point } from "../points.ts";
import { bezier, bezierTangent } from "../swarm.ts";

export type Path = readonly [Point, Point, Point, Point];

export type WalkState = {
  x: number;
  y: number;
  /** Radians; 0 points right, the way the ant mark faces. */
  angle: number;
  /** 0 = legs still, 1 = full gait. */
  amp: number;
  /** Gait cycles walked so far; feed to legAngles. */
  phase: number;
};

/** Pixels walked per gait cycle by a 64 px ant. */
const STRIDE = 26;

function easeInOutSine(u: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * u);
}

function pathLength(path: Path): number {
  let length = 0;
  let prev = path[0];
  for (let i = 1; i <= 32; i++) {
    const p = bezier(path[0], path[1], path[2], path[3], i / 32);
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return length;
}

/**
 * Where a walking ant is at `t`: waiting at the path start, walking at a
 * near-steady pace from `start` for `duration` seconds, then resting at the
 * end. Legs move only while it walks.
 */
export function walkState(
  path: Path,
  t: number,
  start: number,
  duration: number,
): WalkState {
  const u = clamp01((t - start) / duration);
  const e = easeInOutSine(u);
  const p = bezier(path[0], path[1], path[2], path[3], e);
  const tan = bezierTangent(path[0], path[1], path[2], path[3], e);
  const amp =
    u <= 0 || u >= 1
      ? 0
      : smoothstep(0, 0.06, u) * (1 - smoothstep(0.94, 1, u));
  return {
    x: p.x,
    y: p.y,
    angle: Math.atan2(tan.y, tan.x),
    amp,
    phase: (e * pathLength(path)) / STRIDE,
  };
}
