import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { antShapes, drawAnt } from "../launch/antShape";
import { INTER } from "../launch/fonts";
import {
  easeOutExpo,
  lerp,
  mulberry32,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { pickPoints, sampleAlphaPoints } from "../launch/points.ts";
import { type Ant, antState, createAnts } from "../launch/swarm.ts";
import { WIDE_H, WIDE_W } from "../launch/wide/beat.ts";
import type { Tone } from "../launch/wide/employees.ts";
import {
  drawHookShape,
  HOOK_SHAPE_WIDTH,
  type HookShapeId,
} from "./hookShapes.ts";
import { edgeStarts } from "./swarmShape.ts";

/** One explainer's hook: the question in big words, and the trade's tool built by ants. */
export type HookConfig = {
  lines: readonly [string, string];
  subline: string;
  shape: HookShapeId;
  seed: number;
  /** When the first line rises; may be before 0 so frame 0 already shows it. */
  wordsAt: number;
  sublineAt: number;
  /** When the ants leave the edges; may be before 0 so they are already in view. */
  swarmFrom: number;
  /** The bright stage covers the hook between these; the ants take the employee's colour first. */
  stageFrom: number;
  stageTo: number;
  tone: Tone;
};

const INK = "#17151f";
const INK_RGB = [23, 21, 31] as const;
const ANT_COUNT = 700;
/** Where the tool of ants sits: right of the words. */
const SHAPE_AT = { cx: 1350, cy: 560 };
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: WIDE_W,
  height: WIDE_H,
};

function rgbOf(tone: Tone): [number, number, number] {
  const [r, g, b] = (tone.rgb.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
  return [r, g, b];
}

/** Ink turning into `rgb` as `k` goes 0 to 1, rounded like colors.ts. */
function inkTo(rgb: readonly [number, number, number], k: number): string {
  const [r, g, b] = INK_RGB.map((c, i) => Math.round(lerp(c, rgb[i], k)));
  return `rgb(${r} ${g} ${b})`;
}

function silhouettePoints(
  shape: HookShapeId,
): ReturnType<typeof sampleAlphaPoints> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDE_W;
  canvas.height = WIDE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  drawHookShape(shape, ctx, SHAPE_AT.cx, SHAPE_AT.cy, HOOK_SHAPE_WIDTH[shape]);
  return sampleAlphaPoints(
    ctx.getImageData(0, 0, WIDE_W, WIDE_H).data,
    WIDE_W,
    WIDE_H,
    5,
  );
}

/** Builds the hook's swarm once: ants from the top, right and bottom edges into the shape. */
function useShapeSwarm(hook: HookConfig): Ant[] | null {
  const [handle] = useState(() => delayRender("Building the hook swarm"));
  const [ants, setAnts] = useState<Ant[] | null>(null);
  const { shape, seed, swarmFrom } = hook;
  useEffect(() => {
    try {
      const rand = mulberry32(seed);
      const ends = pickPoints(silhouettePoints(shape), ANT_COUNT, rand);
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
            seed: seed + 1,
            releaseAt: swarmFrom,
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
  }, [handle, shape, seed, swarmFrom]);
  return ants;
}

const ShapeSwarm: React.FC<{ ants: Ant[]; t: number; hook: HookConfig }> = ({
  ants,
  t,
  hook,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  const own = useMemo(() => rgbOf(hook.tone), [hook.tone]);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, WIDE_W, WIDE_H);
    const toTone = smoothstep(hook.stageFrom - 0.45, hook.stageFrom, t);
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
          inkTo(own, toTone),
          alpha,
        );
      }
    }
  }, [ants, shapes, own, hook.stageFrom, t]);
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

/** The hook: the question in big words, and ants flying in to build the trade's tool. */
export const HookScene: React.FC<{ t: number; hook: HookConfig }> = ({
  t,
  hook,
}) => {
  const ants = useShapeSwarm(hook);
  if (t > hook.stageTo + 0.1) return null;
  return (
    <>
      {ants ? <ShapeSwarm ants={ants} t={t} hook={hook} /> : null}
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
          <div style={rise(t, hook.wordsAt)}>{hook.lines[0]}</div>
          <div style={rise(t, hook.wordsAt + 0.12)}>{hook.lines[1]}</div>
        </div>
        <div
          style={{
            marginTop: 30,
            fontSize: 60,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: hook.tone.deep,
            ...rise(t, hook.sublineAt),
          }}
        >
          {hook.subline}
        </div>
      </div>
    </>
  );
};
