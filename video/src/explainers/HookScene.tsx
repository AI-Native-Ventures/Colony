import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { antShapes, drawAnt } from "../launch/antShape";
import { antColorOnLight } from "../launch/colors.ts";
import { INTER } from "../launch/fonts";
import {
  easeOutExpo,
  mulberry32,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { pickPoints, sampleAlphaPoints } from "../launch/points.ts";
import { type Ant, antState, createAnts } from "../launch/swarm.ts";
import { WIDE_H, WIDE_W } from "../launch/wide/beat.ts";
import { TONES } from "../launch/wide/employees.ts";
import { drawCroissantSilhouette } from "./croissantShape.ts";
import { EP05 } from "./ep05.ts";
import { edgeStarts } from "./swarmShape.ts";

const INK = "#17151f";
const ANT_COUNT = 700;
const SEED = 20261105;
/** Where the croissant of ants sits: right of the words. */
const SHAPE = { cx: 1350, cy: 560, width: 780 };
/** colors.ts group index for pink, the posts employee. */
const PINK_GROUP = 3;
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: WIDE_W,
  height: WIDE_H,
};

function silhouettePoints(): ReturnType<typeof sampleAlphaPoints> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDE_W;
  canvas.height = WIDE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  drawCroissantSilhouette(ctx, SHAPE.cx, SHAPE.cy, SHAPE.width);
  return sampleAlphaPoints(
    ctx.getImageData(0, 0, WIDE_W, WIDE_H).data,
    WIDE_W,
    WIDE_H,
    5,
  );
}

/** Builds the hook's swarm once: ants from the top, right and bottom edges into a croissant. */
function useCroissantSwarm(): Ant[] | null {
  const [handle] = useState(() => delayRender("Building the croissant swarm"));
  const [ants, setAnts] = useState<Ant[] | null>(null);
  useEffect(() => {
    try {
      const rand = mulberry32(SEED);
      const ends = pickPoints(silhouettePoints(), ANT_COUNT, rand);
      const starts = edgeStarts(
        ANT_COUNT,
        rand,
        { w: WIDE_W, h: WIDE_H },
        ["top", "right", "bottom"],
        1000,
      );
      setAnts(
        createAnts(
          starts,
          ends,
          [{ c1: { x: 1620, y: 260 }, c2: { x: 1180, y: 820 }, spread: 260 }],
          {
            seed: SEED + 1,
            releaseAt: EP05.swarmFrom,
            sweep: 0.3,
            frameWidth: WIDE_W,
            flight: { min: 1.25, spread: 0.55 },
          },
        ),
      );
      continueRender(handle);
    } catch (err: unknown) {
      cancelRender(err);
    }
  }, [handle]);
  return ants;
}

const CroissantSwarm: React.FC<{ ants: Ant[]; t: number }> = ({ ants, t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, WIDE_W, WIDE_H);
    const toPink = smoothstep(EP05.stageFrom - 0.45, EP05.stageFrom, t);
    for (let k = TRAIL_ALPHA.length - 1; k >= 0; k--) {
      const tk = t - k * TRAIL_DT;
      for (const ant of ants) {
        if (k > 0 && tk < ant.release) continue;
        const s = antState(ant, tk);
        const alpha = s.alpha * TRAIL_ALPHA[k];
        if (alpha <= 0.004) continue;
        drawAnt(
          ctx,
          shapes,
          s.x,
          s.y,
          s.angle,
          s.size * (1 - 0.12 * k),
          antColorOnLight(PINK_GROUP, toPink, 0),
          alpha,
        );
      }
    }
  }, [ants, shapes, t]);
  return <canvas ref={ref} width={WIDE_W} height={WIDE_H} style={layer} />;
};

function rise(t: number, at: number, seconds = 0.6): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, seconds));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 26).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/** The hook: the question in big words, and ants flying in to build a croissant. */
export const HookScene: React.FC<{ t: number }> = ({ t }) => {
  const ants = useCroissantSwarm();
  if (t > EP05.stageTo + 0.1) return null;
  return (
    <>
      {ants ? <CroissantSwarm ants={ants} t={t} /> : null}
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 296,
          fontFamily: INTER,
          color: INK,
        }}
      >
        <div
          style={{
            fontSize: 116,
            fontWeight: 800,
            letterSpacing: "-0.045em",
            lineHeight: 1.02,
          }}
        >
          <div style={rise(t, EP05.hookWordsAt)}>When did you</div>
          <div style={rise(t, EP05.hookWordsAt + 0.12)}>last post?</div>
        </div>
        <div
          style={{
            marginTop: 30,
            fontSize: 60,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: TONES.pink.deep,
            ...rise(t, EP05.hookHonestAt),
          }}
        >
          Be honest.
        </div>
      </div>
    </>
  );
};
