import { useLayoutEffect, useMemo, useRef } from "react";
import { antShapes, drawAnt } from "../antShape";
import { mulberry32, smoothstep } from "../math.ts";
import { type Point, pickPoints } from "../points.ts";
import { type Ant, antState, createAnts, type Lane } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";

const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

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
};

function riverAnts(spec: RiverSpec): Ant[] {
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
    sweep: 0.5,
    frameWidth: WIDE_W,
  });
}

/** A river of one employee's ants sweeping across the frame and curling into its avatar. */
export const River: React.FC<{ t: number; spec: RiverSpec }> = ({
  t,
  spec,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const ants = useMemo(() => riverAnts(spec), [spec]);
  const shapes = useMemo(() => antShapes(), []);
  const fade = 1 - smoothstep(spec.landAt - 0.1, spec.landAt + 0.35, t);
  const active = t >= spec.startAt - 0.5 && fade > 0;
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, WIDE_W, WIDE_H);
    if (!active) return;
    for (let k = TRAIL_ALPHA.length - 1; k >= 0; k--) {
      const tk = t - k * TRAIL_DT;
      for (const ant of ants) {
        if (k > 0 && tk < ant.release) continue;
        const s = antState(ant, tk);
        const alpha = s.alpha * TRAIL_ALPHA[k] * fade;
        if (alpha <= 0.004) continue;
        drawAnt(
          ctx,
          shapes,
          s.x,
          s.y,
          s.angle,
          s.size * (1 - 0.12 * k),
          spec.color,
          alpha,
        );
      }
    }
  }, [active, ants, shapes, spec.color, t, fade]);
  if (!active) return null;
  return (
    <canvas
      ref={ref}
      width={WIDE_W}
      height={WIDE_H}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: WIDE_W,
        height: WIDE_H,
      }}
    />
  );
};
