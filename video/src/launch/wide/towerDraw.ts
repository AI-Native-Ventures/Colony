import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { fitFontSize } from "../points.ts";
import { stackY } from "../stack.ts";
import { WIDE_W } from "./beat.ts";
import { INTRO, TOWER_MAX_WIDTH, TOWER_STACK, TOWER_WORDS } from "./intro.ts";

/** Seconds a job takes to slam from big and soft to sharp in its slot. */
const ENTER_SECONDS = 0.38;
const TRACKING = -0.04;
const INK = "#17151f";

function fontAt(family: string, size: number): string {
  return `800 ${size}px "${family}"`;
}

/**
 * Draws the pile of jobs at film time `t` on a wide canvas. "rest" draws the
 * tower exactly as it stands at the break, sharp and opaque: the shapes the
 * ants are sampled from.
 */
export function drawTower(
  ctx: CanvasRenderingContext2D,
  family: string,
  t: number,
  mode: "film" | "rest",
): void {
  const film = mode === "film";
  const at = film ? t : INTRO.release;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const sizes = TOWER_WORDS.map((word) =>
    fitFontSize(
      (s) => {
        ctx.font = fontAt(family, s);
        ctx.letterSpacing = `${TRACKING * s}px`;
        return ctx.measureText(word.text).width;
      },
      word.size,
      TOWER_MAX_WIDTH,
    ),
  );
  const ys = stackY(
    sizes,
    TOWER_WORDS.map((w) => w.at),
    at,
    TOWER_STACK,
  );
  const fadeOut = film ? progress(t, INTRO.release, 0.35) : 0;
  const tremble = film
    ? smoothstep(INTRO.tremble, INTRO.tremble + 0.2, t) *
      (1 - smoothstep(INTRO.release - 0.1, INTRO.release, t))
    : 0;
  TOWER_WORDS.forEach((word, index) => {
    const enter = easeOutExpo(progress(at, word.at, ENTER_SECONDS));
    if (enter <= 0) return;
    const newer = TOWER_WORDS.filter(
      (w) => w.at > word.at && w.at + 0.15 <= at,
    ).length;
    const alpha = film
      ? enter * Math.max(0.55, 1 - 0.07 * newer) * (1 - fadeOut)
      : 1;
    if (alpha <= 0) return;
    const blur = film ? (1 - enter) * 16 + fadeOut * 8 : 0;
    const scale = 1 + (1 - enter) * 0.22 + fadeOut * 0.05;
    const x = WIDE_W / 2 + tremble * 3 * Math.sin(t * 61 + index * 1.7);
    const y =
      ys[index] +
      (1 - enter) * 14 +
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
