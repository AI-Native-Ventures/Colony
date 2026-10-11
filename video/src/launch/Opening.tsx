import { useLayoutEffect, useRef } from "react";
import { AntMark } from "../brand/AntMark";
import { INTER } from "./fonts";
import { LogoReveal } from "./LogoReveal";
import { smoothstep } from "./math.ts";
import { SwarmLayer } from "./SwarmLayer";
import type { Ant } from "./swarm.ts";
import { FRAME_H, FRAME_W } from "./timeline.ts";
import { drawWords, JOB_WORDS } from "./words";

const WordsLayer: React.FC<{ t: number }> = ({ t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    drawWords(ctx, INTER, t, "film");
  }, [t]);
  return (
    <canvas
      ref={ref}
      width={FRAME_W}
      height={FRAME_H}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: FRAME_W,
        height: FRAME_H,
      }}
    />
  );
};

/** The single glowing ant the film opens on; the first word slams in over it. */
const SoloAnt: React.FC<{ t: number }> = ({ t }) => {
  const firstWord = JOB_WORDS[0].at;
  const fade = 1 - smoothstep(firstWord - 0.08, firstWord + 0.15, t);
  if (fade <= 0) return null;
  const breathe = 1 + 0.05 * Math.sin(t * 9);
  const width = 240;
  const height = width * (309 / 466);
  return (
    <div
      style={{
        position: "absolute",
        left: FRAME_W / 2 - width / 2,
        top: FRAME_H / 2 - height / 2,
        width,
        height,
        color: "#f4f3f8",
        opacity: fade,
        transform: `scale(${(breathe * (1 + 0.25 * (1 - fade))).toFixed(4)})`,
        filter:
          "drop-shadow(0 0 22px hsl(258 90% 76% / 0.95)) drop-shadow(0 0 60px hsl(258 90% 66% / 0.6))",
      }}
    >
      <AntMark />
    </div>
  );
};

/** Jobs pile up, break into four rivers of ants, and land as the logo: "Introducing Colony." */
export const Opening: React.FC<{ t: number; ants: Ant[] | null }> = ({
  t,
  ants,
}) => (
  <>
    <SoloAnt t={t} />
    <WordsLayer t={t} />
    {ants ? <SwarmLayer ants={ants} t={t} /> : null}
    <LogoReveal t={t} />
  </>
);
