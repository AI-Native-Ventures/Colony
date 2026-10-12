import { useLayoutEffect, useMemo, useRef } from "react";
import { AntMark } from "../../brand/AntMark";
import { antShapes, drawAnt } from "../antShape";
import { antColorOnLight } from "../colors.ts";
import { INTER } from "../fonts";
import { easeInOutCubic, easeOutExpo, progress, smoothstep } from "../math.ts";
import { type Ant, antState } from "../swarm.ts";
import { TEAM, TONES } from "./employees.ts";
import {
  DEFINITION,
  INTRO,
  type OpeningLayout,
  swarmFade,
  TOWER_WORDS,
  TRADE_WORDS,
  WIDE_OPENING,
} from "./intro.ts";
import { drawTower } from "./towerDraw.ts";
import { WorkerAnt } from "./WorkerAnt";

const INK = "#17151f";
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

function layerOf(layout: OpeningLayout): React.CSSProperties {
  return {
    position: "absolute",
    left: 0,
    top: 0,
    width: layout.w,
    height: layout.h,
  };
}

function rise(t: number, at: number, seconds = 0.7): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, seconds));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 30).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/** The single glowing ant the film opens on. */
const SoloAnt: React.FC<{ t: number; layout: OpeningLayout }> = ({
  t,
  layout,
}) => {
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
        left: layout.w / 2 - width / 2,
        top: layout.h / 2 - height / 2,
        width,
        height,
        color: INK,
        opacity: fade * smoothstep(0, 0.4, t),
        transform: `scale(${(breathe * (1 + 0.25 * (1 - fade))).toFixed(4)})`,
        filter: "drop-shadow(0 10px 22px rgb(23 21 31 / 0.18))",
      }}
    >
      <AntMark />
    </div>
  );
};

/** "The work you love": one trade at a time, big and centred. */
const TradeWords: React.FC<{ t: number; layout: OpeningLayout }> = ({
  t,
  layout,
}) => (
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
            top: layout.trade.top,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: layout.trade.size,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            color: INK,
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

const TowerLayer: React.FC<{ t: number; layout: OpeningLayout }> = ({
  t,
  layout,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = t >= TOWER_WORDS[0].at - 0.05 && t <= INTRO.release + 0.5;
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layout.w, layout.h);
    if (visible) drawTower(ctx, INTER, t, "film", layout);
  }, [t, visible, layout]);
  return (
    <canvas
      ref={ref}
      width={layout.w}
      height={layout.h}
      style={layerOf(layout)}
    />
  );
};

/** The jobs break into four rivers of ants that build the logo, then fade as the name takes over. */
const WideSwarm: React.FC<{
  ants: Ant[];
  t: number;
  layout: OpeningLayout;
}> = ({ ants, t, layout }) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  const active = t >= INTRO.release - 0.2 && swarmFade(t) > 0;
  useLayoutEffect(() => {
    const sharpCanvas = sharpRef.current;
    const sharp = sharpCanvas?.getContext("2d");
    if (!sharpCanvas || !sharp) return;
    sharp.setTransform(1, 0, 0, 1, 0, 0);
    sharp.globalAlpha = 1;
    sharp.clearRect(0, 0, layout.w, layout.h);
    if (!active) return;
    const settle = swarmFade(t);
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
          antColorOnLight(ant.group, s.toGroup, unite),
          alpha,
        );
      }
    }
  }, [active, ants, shapes, t, layout]);
  return (
    <canvas
      ref={sharpRef}
      width={layout.w}
      height={layout.h}
      style={layerOf(layout)}
    />
  );
};

/** The logo lands, "Introducing Colony.", what it is; then it steps back so "AI employee" can be defined. */
const LogoAndName: React.FC<{ t: number; layout: OpeningLayout }> = ({
  t,
  layout,
}) => {
  if (t < INTRO.logoIn - 0.3) return null;
  const logoIn = smoothstep(INTRO.logoIn, INTRO.logoIn + 0.4, t);
  const pulse = progress(t, INTRO.logoIn + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow = 0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4));
  const ringAlpha = pulse > 0 ? 0.45 * (1 - ring) : 0;
  const step = easeInOutCubic(progress(t, INTRO.defineFrom, 0.9));
  const nameOut = smoothstep(INTRO.defineFrom - 0.1, INTRO.defineFrom + 0.4, t);
  // The logo glides up and shrinks to make room for the definition.
  const logoScale = 1 - 0.55 * step;
  const logoShift = layout.logoShift * step;
  const L = layout.logo;
  // The glow is 2.3 logos wide and the ring 1.15; integer maths keeps the film's 920 and 460 exact.
  const glow2 = (L.width * 23) / 10;
  const ring2 = (L.width * 115) / 100;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: L.cx - glow2 / 2,
          top: L.cy - glow2 / 2,
          width: glow2,
          height: glow2,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgb(255 255 255 / 0.6) 0%, rgb(255 255 255 / 0.18) 40%, transparent 70%)",
          opacity: glow * (1 - 0.6 * step),
          transform: `translateY(${logoShift.toFixed(2)}px) scale(${((0.7 + 0.35 * ring) * logoScale).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: L.cx - ring2 / 2,
          top: L.cy - ring2 / 2,
          width: ring2,
          height: ring2,
          borderRadius: "50%",
          border: `3px solid rgb(23 21 31 / ${(ringAlpha * 0.5).toFixed(3)})`,
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
          color: INK,
          opacity: logoIn,
          transform: `translateY(${logoShift.toFixed(2)}px) scale(${logoScale.toFixed(4)})`,
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
            color: "rgb(23 21 31 / 0.62)",
            ...rise(t, INTRO.introducing),
          }}
        >
          Introducing
        </div>
        <div
          style={{
            fontSize: 132,
            fontWeight: 800,
            color: INK,
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
            color: "rgb(23 21 31 / 0.78)",
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
const Definition: React.FC<{ t: number; layout: OpeningLayout }> = ({
  t,
  layout,
}) => {
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
          top: layout.define.top,
          textAlign: "center",
          fontFamily: INTER,
        }}
      >
        <div
          style={{
            fontSize: 112,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            color: INK,
            ...rise(t, INTRO.defineFrom + 0.25),
          }}
        >
          {DEFINITION.title}
        </div>
        <div
          style={{
            width: layout.define.width,
            margin: "26px auto 0",
            fontSize: 48,
            fontWeight: 600,
            lineHeight: 1.3,
            color: "rgb(23 21 31 / 0.75)",
            textWrap: "balance",
            ...rise(t, INTRO.defineFrom + 0.55),
          }}
        >
          {DEFINITION.body}
        </div>
      </div>
      {TEAM.map((who, k) => {
        const gap = layout.team.gap;
        const endX = layout.w / 2 - 1.5 * gap + k * gap;
        const x = -160 - (3 - k) * gap + (endX + 160 + (3 - k) * gap) * pace;
        return (
          <WorkerAnt
            key={who}
            x={x}
            y={layout.team.y}
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
export const WideOpening: React.FC<{
  t: number;
  ants: Ant[] | null;
  /** The wide film's layout unless given. */
  layout?: OpeningLayout;
}> = ({ t, ants, layout = WIDE_OPENING }) => {
  if (t > INTRO.brightTo + 0.2) return null;
  return (
    <>
      <SoloAnt t={t} layout={layout} />
      <TradeWords t={t} layout={layout} />
      <TowerLayer t={t} layout={layout} />
      {ants ? <WideSwarm ants={ants} t={t} layout={layout} /> : null}
      <LogoAndName t={t} layout={layout} />
      <Definition t={t} layout={layout} />
    </>
  );
};
