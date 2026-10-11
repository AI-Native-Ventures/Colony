import { useLayoutEffect, useMemo, useRef } from "react";
import { AntMark } from "../../brand/AntMark";
import { antShapes, drawAnt } from "../antShape";
import { antColor } from "../colors.ts";
import { INTER } from "../fonts";
import { easeInOutCubic, easeOutExpo, progress, smoothstep } from "../math.ts";
import { type Ant, antState } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";
import { TEAM, TONES } from "./employees.ts";
import { INTRO, TOWER_WORDS, TRADE_WORDS, WIDE_LOGO_RECT } from "./intro.ts";
import { drawTower } from "./towerDraw.ts";
import { WorkerAnt } from "./WorkerAnt";

const VIOLET = "hsl(258 90% 66%)";
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: WIDE_W,
  height: WIDE_H,
};

function rise(t: number, at: number, seconds = 0.7): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, seconds));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 30).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/** The single glowing ant the film opens on. */
const SoloAnt: React.FC<{ t: number }> = ({ t }) => {
  const first = TRADE_WORDS[0].at;
  const fade = 1 - smoothstep(first - 0.1, first + 0.15, t);
  if (fade <= 0) return null;
  const breathe = 1 + 0.05 * Math.sin(t * 9);
  const width = 200;
  const height = width * (309 / 466);
  return (
    <div
      style={{
        position: "absolute",
        left: WIDE_W / 2 - width / 2,
        top: WIDE_H / 2 - height / 2,
        width,
        height,
        color: "#f4f3f8",
        opacity: fade * smoothstep(0, 0.4, t),
        transform: `scale(${(breathe * (1 + 0.25 * (1 - fade))).toFixed(4)})`,
        filter:
          "drop-shadow(0 0 22px hsl(258 90% 76% / 0.95)) drop-shadow(0 0 60px hsl(258 90% 66% / 0.6))",
      }}
    >
      <AntMark />
    </div>
  );
};

/** "The work you love": one trade at a time, big and centred. */
const TradeWords: React.FC<{ t: number }> = ({ t }) => (
  <>
    {TRADE_WORDS.map((word, i) => {
      const next = TRADE_WORDS[i + 1]?.at ?? INTRO.tradesOut;
      if (t < word.at || t > next + 0.05) return null;
      const enter = easeOutExpo(progress(t, word.at, 0.38));
      // The old word is gone before the next one sharpens, so two never overlap.
      const leave = smoothstep(next - 0.14, next + 0.02, t);
      return (
        <div
          key={word.text}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: WIDE_H / 2 - 100,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: 168,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            color: "#f4f3f8",
            opacity: enter * (1 - leave),
            transform: `scale(${(1 + (1 - enter) * 0.18 - 0.04 * leave).toFixed(4)})`,
            filter: `blur(${((1 - enter) * 14 + leave * 8).toFixed(2)}px)`,
          }}
        >
          {word.text}
        </div>
      );
    })}
  </>
);

const TowerLayer: React.FC<{ t: number }> = ({ t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = t >= TOWER_WORDS[0].at - 0.05 && t <= INTRO.release + 0.5;
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, WIDE_W, WIDE_H);
    if (visible) drawTower(ctx, INTER, t, "film");
  }, [t, visible]);
  return <canvas ref={ref} width={WIDE_W} height={WIDE_H} style={layer} />;
};

/** The jobs break into four rivers of ants that build the logo, then fade as the name takes over. */
const WideSwarm: React.FC<{ ants: Ant[]; t: number }> = ({ ants, t }) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  const active = t >= INTRO.release - 0.2 && t <= INTRO.defineFrom + 0.2;
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
    const settle =
      (1 - 0.85 * progress(t, INTRO.logoIn, 0.45)) *
      (1 - smoothstep(INTRO.defineFrom - 0.4, INTRO.defineFrom, t));
    const unite = smoothstep(INTRO.logoIn - 0.2, INTRO.logoIn + 0.15, t);
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
    glow.drawImage(sharpCanvas, 0, 0);
  }, [active, ants, shapes, t]);
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

/** The logo lands, "Introducing Colony.", what it is; then it steps back so "AI employee" can be defined. */
const LogoAndName: React.FC<{ t: number }> = ({ t }) => {
  if (t < INTRO.logoIn - 0.3) return null;
  const logoIn = smoothstep(INTRO.logoIn, INTRO.logoIn + 0.4, t);
  const pulse = progress(t, INTRO.logoIn + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow =
    0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    0.22 * smoothstep(INTRO.logoIn, INTRO.logoIn + 0.6, t);
  const ringAlpha = pulse > 0 ? 0.45 * (1 - ring) : 0;
  const step = easeInOutCubic(progress(t, INTRO.defineFrom, 0.9));
  const nameOut = smoothstep(INTRO.defineFrom - 0.1, INTRO.defineFrom + 0.4, t);
  // The logo glides up and shrinks to make room for the definition.
  const logoScale = 1 - 0.55 * step;
  const logoShift = -200 * step;
  const L = WIDE_LOGO_RECT;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: L.cx - 460,
          top: L.cy - 460,
          width: 920,
          height: 920,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, hsl(258 90% 66% / 0.5) 0%, hsl(258 90% 66% / 0.1) 38%, transparent 70%)",
          opacity: glow * (1 - 0.6 * step),
          transform: `translateY(${logoShift.toFixed(2)}px) scale(${((0.7 + 0.35 * ring) * logoScale).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: L.cx - 230,
          top: L.cy - 230,
          width: 460,
          height: 460,
          borderRadius: "50%",
          border: `3px solid hsl(258 90% 76% / ${ringAlpha.toFixed(3)})`,
          transform: `scale(${(0.6 + 1.1 * ring).toFixed(4)})`,
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
          transform: `translateY(${logoShift.toFixed(2)}px) scale(${logoScale.toFixed(4)})`,
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
          top: L.cy + L.height / 2 + 40,
          textAlign: "center",
          fontFamily: INTER,
          opacity: 1 - nameOut,
        }}
      >
        <div
          style={{
            fontSize: 40,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.72)",
            ...rise(t, INTRO.introducing),
          }}
        >
          Introducing
        </div>
        <div
          style={{
            fontSize: 132,
            fontWeight: 800,
            color: "#ffffff",
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
            marginTop: 4,
            ...rise(t, INTRO.name),
          }}
        >
          Colony.
        </div>
        <div
          style={{
            fontSize: 46,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.82)",
            marginTop: 18,
            ...rise(t, INTRO.tagline),
          }}
        >
          AI employees for your business.
        </div>
      </div>
    </>
  );
};

/** "AI employee", defined in one plain sentence, while four ants walk in like a small team. */
const Definition: React.FC<{ t: number }> = ({ t }) => {
  if (t < INTRO.defineFrom) return null;
  const walk = progress(t, INTRO.teamWalkFrom, 3.2);
  const pace = easeInOutCubic(walk);
  const moving = walk > 0 && walk < 1 ? 1 : 0;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 400,
          textAlign: "center",
          fontFamily: INTER,
        }}
      >
        <div
          style={{
            fontSize: 112,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            color: "#ffffff",
            ...rise(t, INTRO.defineFrom + 0.25),
          }}
        >
          AI employee
        </div>
        <div
          style={{
            width: 1100,
            margin: "26px auto 0",
            fontSize: 48,
            fontWeight: 600,
            lineHeight: 1.3,
            color: "rgb(236 235 243 / 0.85)",
            textWrap: "balance",
            ...rise(t, INTRO.defineFrom + 0.55),
          }}
        >
          Software that does office work for you, like a person on your team.
        </div>
      </div>
      {TEAM.map((who, k) => {
        const endX = WIDE_W / 2 - 1.5 * 130 + k * 130;
        const x = -160 - (3 - k) * 130 + (endX + 160 + (3 - k) * 130) * pace;
        return (
          <WorkerAnt
            key={who}
            x={x}
            y={860}
            angle={0}
            size={84}
            color={TONES[who].color}
            phase={(t - INTRO.teamWalkFrom) * 4 + k * 0.3}
            amp={moving * (1 - smoothstep(0.85, 1, walk))}
            opacity={smoothstep(
              INTRO.teamWalkFrom,
              INTRO.teamWalkFrom + 0.3,
              t,
            )}
          />
        );
      })}
    </>
  );
};

/** The dark opening: who it is for, the swarm, Colony, and what an AI employee is. */
export const WideOpening: React.FC<{ t: number; ants: Ant[] | null }> = ({
  t,
  ants,
}) => {
  if (t > INTRO.brightTo + 0.2) return null;
  return (
    <>
      <SoloAnt t={t} />
      <TradeWords t={t} />
      <TowerLayer t={t} />
      {ants ? <WideSwarm ants={ants} t={t} /> : null}
      <LogoAndName t={t} />
      <Definition t={t} />
    </>
  );
};
