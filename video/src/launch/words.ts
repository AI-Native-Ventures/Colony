import { easeOutExpo, progress, smoothstep } from "./math.ts";
import { fitFontSize } from "./points.ts";
import { FRAME_W, T_RELEASE, T_TREMBLE, TEXT_MAX_WIDTH } from "./timeline.ts";

export type JobWord = { text: string; at: number };

/** The owner's to-do list. Not promises: only four of these are Colony employees. */
export const JOB_WORDS: JobWord[] = [
  { text: "Find customers", at: 0.08 },
  { text: "Post on Instagram", at: 0.34 },
  { text: "Reply to emails", at: 0.58 },
  { text: "Update the website", at: 0.8 },
  { text: "Send quotes", at: 1.0 },
  { text: "Chase invoices", at: 1.18 },
];

const DESIRED_SIZE = 116;
const LINE_STEP = 132;
const STACK_CENTER_Y = 960;
const TRACKING = -0.035;
const INK = "#f4f3f8";

function fontAt(family: string, size: number): string {
  return `800 ${size}px "${family}"`;
}

/**
 * Draws the job words at time `t`. "rest" draws every word fully landed,
 * sharp and opaque: the exact shapes the ants are sampled from.
 */
export function drawWords(
  ctx: CanvasRenderingContext2D,
  family: string,
  t: number,
  mode: "film" | "rest",
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const top = STACK_CENTER_Y - ((JOB_WORDS.length - 1) * LINE_STEP) / 2;
  const film = mode === "film";
  const fadeOut = film ? progress(t, T_RELEASE, 0.25) : 0;
  const tremble = film
    ? smoothstep(T_TREMBLE, T_TREMBLE + 0.25, t) *
      (1 - smoothstep(T_RELEASE - 0.12, T_RELEASE, t))
    : 0;
  JOB_WORDS.forEach((word, index) => {
    const size = fitFontSize(
      (s) => {
        ctx.font = fontAt(family, s);
        ctx.letterSpacing = `${TRACKING * s}px`;
        return ctx.measureText(word.text).width;
      },
      DESIRED_SIZE,
      TEXT_MAX_WIDTH,
    );
    const enter = film ? easeOutExpo(progress(t, word.at, 0.42)) : 1;
    if (enter <= 0) return;
    const newer = film
      ? JOB_WORDS.filter((w) => w.at > word.at && w.at + 0.2 <= t).length
      : 0;
    const alpha = film
      ? enter * Math.max(0.42, 1 - 0.12 * newer) * (1 - fadeOut)
      : 1;
    if (alpha <= 0) return;
    const blur = film ? (1 - enter) * 18 + fadeOut * 6 : 0;
    const scale = 1 + (1 - enter) * 0.08 + fadeOut * 0.04;
    const x = FRAME_W / 2 + tremble * 2.4 * Math.sin(t * 61 + index * 1.7);
    const y =
      top +
      index * LINE_STEP +
      (1 - enter) * 40 +
      tremble * 2.4 * Math.cos(t * 53 + index * 2.3);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = fontAt(family, size);
    ctx.letterSpacing = `${TRACKING * size}px`;
    ctx.fillText(word.text, 0, 0);
    ctx.restore();
  });
}
