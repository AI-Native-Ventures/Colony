import { useLayoutEffect, useMemo, useRef } from "react";
import { antShapes, drawAnt } from "../antShape";
import { smoothstep } from "../math.ts";
import { antState } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";
import { type RiverSpec, riverAnts } from "./riverAnts.ts";

const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

/**
 * A river of one employee's ants curling into its avatar. Positions are on
 * the long canvas; `offsetX` and `offsetY` are where the camera is on it, so
 * the trails stay put in the world while the camera glides. `width` and
 * `height` are the frame's (the wide film's unless given).
 */
export const River: React.FC<{
  t: number;
  spec: RiverSpec;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
}> = ({
  t,
  spec,
  offsetX = 0,
  offsetY = 0,
  width = WIDE_W,
  height = WIDE_H,
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
    ctx.clearRect(0, 0, width, height);
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
          s.x - offsetX,
          s.y - offsetY,
          s.angle,
          s.size * (1 - 0.12 * k),
          spec.color,
          alpha,
        );
      }
    }
  }, [
    active,
    ants,
    shapes,
    spec.color,
    t,
    fade,
    offsetX,
    offsetY,
    width,
    height,
  ]);
  if (!active) return null;
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
      }}
    />
  );
};
