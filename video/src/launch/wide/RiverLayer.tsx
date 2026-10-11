import { useLayoutEffect, useMemo, useRef } from "react";
import { antShapes, drawAnt } from "../antShape";
import { mulberry32, smoothstep } from "../math.ts";
import { type Point, pickPoints } from "../points.ts";
import { type Ant, antState, createAnts } from "../swarm.ts";
import { AVATAR, BEAT, WIDE_H, WIDE_W } from "./beat.ts";

const BLUE = "rgb(60 131 246)";
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];
const COUNT = 220;

/** A blue river of ants from off the left edge, curling into the employee's avatar. */
function riverAnts(): Ant[] {
  const rand = mulberry32(7101);
  const starts: Point[] = Array.from({ length: COUNT }, () => ({
    x: -320 + rand() * 280,
    y: 640 + rand() * 380,
  }));
  const pool: Point[] = [];
  for (let y = -48; y <= 48; y += 7) {
    for (let x = -48; x <= 48; x += 7) {
      if (x * x + y * y <= 48 * 48)
        pool.push({ x: AVATAR.x + x, y: AVATAR.y + y });
    }
  }
  return createAnts(
    starts,
    pickPoints(pool, COUNT, rand),
    [{ c1: { x: 1500, y: 1180 }, c2: { x: 1250, y: -160 }, spread: 170 }],
    { seed: 7102, releaseAt: BEAT.riverFrom, sweep: 0.5, frameWidth: WIDE_W },
  );
}

export const RiverLayer: React.FC<{ t: number }> = ({ t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const ants = useMemo(() => riverAnts(), []);
  const shapes = useMemo(() => antShapes(), []);
  const fade = 1 - smoothstep(BEAT.avatarAt - 0.1, BEAT.avatarAt + 0.35, t);
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, WIDE_W, WIDE_H);
    if (fade <= 0) return;
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
          BLUE,
          alpha,
        );
      }
    }
  }, [ants, shapes, t, fade]);
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
