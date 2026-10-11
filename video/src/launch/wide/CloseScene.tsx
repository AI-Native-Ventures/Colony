import { useLayoutEffect, useMemo, useRef } from "react";
import { AntMark } from "../../brand/AntMark";
import { antShapes, drawAnt } from "../antShape";
import { antColor } from "../colors.ts";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { type Ant, antState } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";
import { CLOSE_LOGO, type CLOSE90 } from "./film90.ts";

const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: WIDE_W,
  height: WIDE_H,
};

/** The four colors fly home and build the logo, then unite into violet, as in the opening. */
const CloseSwarm: React.FC<{
  ants: Ant[];
  t: number;
  timing: typeof CLOSE90;
}> = ({ ants, t, timing }) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  const active = t >= timing.dimFrom && t <= timing.logoIn + 1.2;
  useLayoutEffect(() => {
    const sharpCanvas = sharpRef.current;
    const sharp = sharpCanvas?.getContext("2d");
    const glow = glowRef.current?.getContext("2d");
    if (!sharpCanvas || !sharp || !glow) return;
    sharp.setTransform(1, 0, 0, 1, 0, 0);
    sharp.globalAlpha = 1;
    sharp.clearRect(0, 0, WIDE_W, WIDE_H);
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.globalAlpha = 1;
    glow.clearRect(0, 0, WIDE_W, WIDE_H);
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
          antColor(ant.group, 1, unite),
          alpha,
        );
      }
    }
    glow.drawImage(sharpCanvas, 0, 0);
  }, [active, ants, shapes, t, timing]);
  return (
    <>
      <canvas
        ref={glowRef}
        width={WIDE_W}
        height={WIDE_H}
        style={{
          ...layer,
          filter: "blur(18px) saturate(1.5)",
          opacity: 0.9,
          mixBlendMode: "screen",
        }}
      />
      <canvas ref={sharpRef} width={WIDE_W} height={WIDE_H} style={layer} />
    </>
  );
};

const VIOLET = "hsl(258 90% 66%)";

function rise(t: number, at: number, seconds = 0.7): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, seconds));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 28).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/** The close: the ants are home, the logo lands, then the name, what it is, and where to get it. */
export const CloseScene: React.FC<{
  t: number;
  timing: typeof CLOSE90;
  ants: Ant[] | null;
}> = ({ t, timing, ants }) => {
  if (t < timing.dimFrom) return null;
  const swarm = ants ? <CloseSwarm ants={ants} t={t} timing={timing} /> : null;
  if (t < timing.logoIn - 0.4) return swarm;
  const logoIn = smoothstep(timing.logoIn, timing.logoIn + 0.4, t);
  const pulse = progress(t, timing.logoIn + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow =
    0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    0.22 * smoothstep(timing.logoIn, timing.logoIn + 0.6, t);
  const L = CLOSE_LOGO;
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
            "radial-gradient(circle, hsl(258 90% 66% / 0.5) 0%, hsl(258 90% 66% / 0.1) 38%, transparent 70%)",
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
          color: VIOLET,
          opacity: logoIn,
          filter: `drop-shadow(0 0 ${(24 * logoIn).toFixed(1)}px hsl(258 90% 66% / 0.6))`,
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
            fontSize: 140,
            fontWeight: 800,
            color: "#ffffff",
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
            ...rise(t, timing.name),
          }}
        >
          Colony.
        </div>
        <div
          style={{
            fontSize: 50,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.85)",
            marginTop: 14,
            ...rise(t, timing.tagline),
          }}
        >
          AI employees for your business.
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.62)",
            marginTop: 54,
            ...rise(t, timing.earlyAt),
          }}
        >
          Early access is open
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 84,
            padding: "0 40px",
            marginTop: 18,
            borderRadius: 999,
            background: VIOLET,
            color: "#ffffff",
            fontSize: 44,
            fontWeight: 750,
            letterSpacing: "-0.01em",
            boxShadow: "0 24px 60px -24px hsl(258 90% 60% / 0.9)",
            ...rise(t, timing.urlAt),
          }}
        >
          colony.ainative.ventures
        </div>
      </div>
    </>
  );
};
