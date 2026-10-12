import { useLayoutEffect, useMemo, useRef } from "react";
import { AntMark } from "../../brand/AntMark";
import { antShapes, drawAnt } from "../antShape";
import { antColorOnLight } from "../colors.ts";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { type Ant, antState } from "../swarm.ts";
import { CLOSE_WORDS, type CloseLayout, WIDE_CLOSE } from "./closeLayout.ts";
import type { CLOSE90 } from "./film90.ts";

const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

/** The four colors fly home and build the logo, then unite into violet, as in the opening. */
const CloseSwarm: React.FC<{
  ants: Ant[];
  t: number;
  timing: typeof CLOSE90;
  width: number;
  height: number;
}> = ({ ants, t, timing, width, height }) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  const active = t >= timing.dimFrom && t <= timing.logoIn + 1.2;
  useLayoutEffect(() => {
    const sharpCanvas = sharpRef.current;
    const sharp = sharpCanvas?.getContext("2d");
    if (!sharpCanvas || !sharp) return;
    sharp.setTransform(1, 0, 0, 1, 0, 0);
    sharp.globalAlpha = 1;
    sharp.clearRect(0, 0, width, height);
    if (!active) return;
    const settle = 1 - progress(t, timing.logoIn, 0.6);
    const unite = smoothstep(timing.logoIn - 0.2, timing.logoIn + 0.15, t);
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
          antColorOnLight(ant.group, 1, unite),
          alpha,
        );
      }
    }
  }, [active, ants, shapes, t, timing, width, height]);
  return (
    <canvas
      ref={sharpRef}
      width={width}
      height={height}
      style={{ position: "absolute", left: 0, top: 0, width, height }}
    />
  );
};

const INK = "#17151f";

function rise(t: number, at: number, seconds = 0.7): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, seconds));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 28).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/**
 * The close: the ants are home, the logo lands, then the name, what it is,
 * and where to get it. `layout` is the frame and where the logo lands (the
 * wide film's unless given).
 */
export const CloseScene: React.FC<{
  t: number;
  timing: typeof CLOSE90;
  ants: Ant[] | null;
  /** No shadow under the logo and no glow left after the flash (owner note on the intro, cut 4). */
  plain?: boolean;
  layout?: CloseLayout;
}> = ({ t, timing, ants, plain = false, layout = WIDE_CLOSE }) => {
  if (t < timing.dimFrom) return null;
  const swarm = ants ? (
    <CloseSwarm
      ants={ants}
      t={t}
      timing={timing}
      width={layout.w}
      height={layout.h}
    />
  ) : null;
  if (t < timing.logoIn - 0.4) return swarm;
  const logoIn = smoothstep(timing.logoIn, timing.logoIn + 0.4, t);
  const pulse = progress(t, timing.logoIn + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow =
    0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    (plain ? 0 : 0.22 * smoothstep(timing.logoIn, timing.logoIn + 0.6, t));
  const L = layout.logo;
  return (
    <>
      {swarm}
      <div
        style={{
          position: "absolute",
          left: L.cx - 420,
          top: L.cy - 420,
          width: 840,
          height: 840,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgb(255 255 255 / 0.6) 0%, rgb(255 255 255 / 0.18) 40%, transparent 70%)",
          opacity: glow,
          transform: `scale(${(0.7 + 0.35 * ring).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: L.cx - L.width / 2,
          top: L.cy - L.height / 2,
          width: L.width,
          height: L.height,
          color: INK,
          opacity: logoIn,
          filter: plain
            ? undefined
            : `drop-shadow(0 18px 30px rgb(23 21 31 / ${(0.18 * logoIn).toFixed(3)}))`,
        }}
      >
        <AntMark />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: L.cy + L.height / 2 + 26,
          textAlign: "center",
          fontFamily: INTER,
        }}
      >
        <div
          style={{
            fontSize: layout.name,
            fontWeight: 800,
            color: INK,
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
            ...rise(t, timing.name),
          }}
        >
          {CLOSE_WORDS.name}
        </div>
        <div
          style={{
            fontSize: layout.tagline,
            fontWeight: 600,
            color: "rgb(23 21 31 / 0.78)",
            marginTop: 14,
            ...rise(t, timing.tagline),
          }}
        >
          {CLOSE_WORDS.tagline}
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 600,
            color: "rgb(23 21 31 / 0.6)",
            marginTop: 54,
            ...rise(t, timing.earlyAt),
          }}
        >
          {CLOSE_WORDS.early}
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 84,
            padding: "0 40px",
            marginTop: 18,
            borderRadius: 999,
            background: INK,
            color: "#ffffff",
            fontSize: 44,
            fontWeight: 750,
            letterSpacing: "-0.01em",
            boxShadow: "0 24px 60px -24px rgb(23 21 31 / 0.55)",
            ...rise(t, timing.urlAt),
          }}
        >
          {CLOSE_WORDS.address}
        </div>
      </div>
    </>
  );
};
