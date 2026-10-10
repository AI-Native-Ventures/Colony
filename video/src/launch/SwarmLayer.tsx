import { useLayoutEffect, useMemo, useRef } from "react";
import { antShapes, drawAnt } from "./antShape";
import { antColor } from "./colors.ts";
import { progress, smoothstep } from "./math.ts";
import { type Ant, antState } from "./swarm.ts";
import { FRAME_H, FRAME_W, T_LOGO_IN } from "./timeline.ts";

/** Motion trail: earlier positions, seconds apart, fading out. */
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: FRAME_W,
  height: FRAME_H,
};

export const SwarmLayer: React.FC<{ ants: Ant[]; t: number }> = ({
  ants,
  t,
}) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  useLayoutEffect(() => {
    const sharpCanvas = sharpRef.current;
    const sharp = sharpCanvas?.getContext("2d");
    const glow = glowRef.current?.getContext("2d");
    if (!sharpCanvas || !sharp || !glow) return;
    sharp.setTransform(1, 0, 0, 1, 0, 0);
    sharp.globalAlpha = 1;
    sharp.clearRect(0, 0, FRAME_W, FRAME_H);
    // Once the crisp logo arrives, the swarm fades to a faint halo under it.
    const settle = 1 - 0.85 * progress(t, T_LOGO_IN, 0.45);
    // The four colors build their own parts of the mark, then unite into violet together.
    const unite = smoothstep(T_LOGO_IN - 0.2, T_LOGO_IN + 0.15, t);
    for (let k = TRAIL_ALPHA.length - 1; k >= 0; k--) {
      const tk = t - k * TRAIL_DT;
      for (const ant of ants) {
        if (k > 0 && tk < ant.release) continue;
        const s = antState(ant, tk);
        const alpha = s.alpha * TRAIL_ALPHA[k] * settle;
        if (alpha <= 0.004) continue;
        drawAnt(
          sharp,
          shapes,
          s.x,
          s.y,
          s.angle,
          s.size * (1 - 0.12 * k),
          antColor(ant.group, s.toGroup, unite),
          alpha,
        );
      }
    }
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.globalAlpha = 1;
    glow.clearRect(0, 0, FRAME_W, FRAME_H);
    glow.drawImage(sharpCanvas, 0, 0);
  }, [ants, shapes, t]);
  return (
    <>
      <canvas
        ref={glowRef}
        width={FRAME_W}
        height={FRAME_H}
        style={{
          ...layer,
          filter: "blur(18px) saturate(1.5)",
          opacity: 0.9,
          mixBlendMode: "screen",
        }}
      />
      <canvas ref={sharpRef} width={FRAME_W} height={FRAME_H} style={layer} />
    </>
  );
};
