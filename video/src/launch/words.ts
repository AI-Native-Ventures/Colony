import { easeOutExpo, progress, smoothstep } from "./math.ts";
import { fitFontSize } from "./points.ts";
import { stackY } from "./stack.ts";
import { FRAME_W, T_RELEASE, T_TREMBLE, TEXT_MAX_WIDTH } from "./timeline.ts";

export type JobWord = { text: string; at: number; size: number };

/**
 * The owner's to-do list, landing into a tower. The first jobs come slowly
 * enough to read; then they speed up until the pile feels like too much.
 * Not promises: only four of these are Colony employees.
 */
export const JOB_WORDS: JobWord[] = [
  { text: "Find customers", at: 0.3, size: 150 },
  { text: "Post on Instagram", at: 0.85, size: 132 },
  { text: "Reply to emails", at: 1.35, size: 162 },
  { text: "Update the website", at: 1.8, size: 126 },
  { text: "Send quotes", at: 2.2, size: 158 },
  { text: "Chase invoices", at: 2.55, size: 140 },
  { text: "Do the books", at: 2.85, size: 160 },
  { text: "Answer the phone", at: 3.1, size: 134 },
  { text: "Write the newsletter", at: 3.32, size: 128 },
];

/** Seconds a word takes to slam from big and soft to sharp in its slot. */
export const ENTER_SECONDS = 0.38;

const STACK = { centerY: 960, leading: 0.94, pushSeconds: 0.22 };
const TRACKING = -0.04;
const INK = "#f4f3f8";

function fontAt(family: string, size: number): string {
  return `800 ${size}px "${family}"`;
}

/**
 * Draws the job words at time `t`. "rest" draws the tower exactly as it
 * stands at T_RELEASE, sharp and opaque: the shapes the ants are sampled from.
 */
export function drawWords(
  ctx: CanvasRenderingContext2D,
  family: string,
  t: number,
  mode: "film" | "rest",
): void {
  const film = mode === "film";
  const at = film ? t : T_RELEASE;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const sizes = JOB_WORDS.map((word) =>
    fitFontSize(
      (s) => {
        ctx.font = fontAt(family, s);
        ctx.letterSpacing = `${TRACKING * s}px`;
        return ctx.measureText(word.text).width;
      },
      word.size,
      TEXT_MAX_WIDTH,
    ),
  );
  const ys = stackY(
    sizes,
    JOB_WORDS.map((w) => w.at),
    at,
    STACK,
  );
  const fadeOut = film ? progress(t, T_RELEASE, 0.35) : 0;
  const tremble = film
    ? smoothstep(T_TREMBLE, T_TREMBLE + 0.2, t) *
      (1 - smoothstep(T_RELEASE - 0.1, T_RELEASE, t))
    : 0;
  JOB_WORDS.forEach((word, index) => {
    const enter = easeOutExpo(progress(at, word.at, ENTER_SECONDS));
    if (enter <= 0) return;
    const newer = JOB_WORDS.filter(
      (w) => w.at > word.at && w.at + 0.15 <= at,
    ).length;
    const alpha = film
      ? enter * Math.max(0.55, 1 - 0.07 * newer) * (1 - fadeOut)
      : 1;
    if (alpha <= 0) return;
    // Each word slams down into its own slot: big and soft to sharp, barely any travel, so it never lands on its neighbour.
    const blur = film ? (1 - enter) * 16 + fadeOut * 8 : 0;
    const scale = 1 + (1 - enter) * 0.22 + fadeOut * 0.05;
    const x = FRAME_W / 2 + tremble * 3 * Math.sin(t * 61 + index * 1.7);
    const y =
      ys[index] +
      (1 - enter) * 18 +
      tremble * 3 * Math.cos(t * 53 + index * 2.3);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = fontAt(family, sizes[index]);
    ctx.letterSpacing = `${TRACKING * sizes[index]}px`;
    ctx.fillText(word.text, 0, 0);
    ctx.restore();
  });
}
