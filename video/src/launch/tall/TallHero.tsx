import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { progress, smoothstep } from "../math.ts";
import { fitFontSize } from "../points.ts";
import {
  easeOutBack,
  type HeroTiming,
  PersonGlyph,
  wordIn,
} from "../wide/EmployeeHero";
import type { HeroLook } from "../wide/employees.ts";
import { HERO } from "./hero.ts";

const INK = "#17151f";
const MUTED = "#5d5a6b";
const TRACKING = -0.045;

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** The title's size on one line: the hero size, smaller only if the line would be wider than the frame allows. */
function titleSize(text: string): number {
  if (!measureCtx)
    measureCtx = document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (!ctx) return HERO.titleSize;
  return fitFontSize(
    (s) => {
      ctx.font = `800 ${s}px "${INTER}"`;
      ctx.letterSpacing = `${TRACKING * s}px`;
      return ctx.measureText(text).width;
    },
    HERO.titleSize,
    HERO.titleWidth,
  );
}

/** The employee steps forward on a tall frame: avatar and badge, the job on one line, one plain sentence. */
export const TallHero: React.FC<{
  t: number;
  look: HeroLook;
  timing: HeroTiming;
}> = ({ t, look, timing }) => {
  const pop = progress(t, timing.avatarAt - 0.05, 0.55);
  if (pop <= 0) return null;
  const scale = easeOutBack(pop);
  const ring = progress(t, timing.avatarAt, 1.1);
  const focusAway =
    timing.focusFrom === undefined
      ? 0
      : smoothstep(timing.focusFrom, timing.focusFrom + 0.8, t);
  const { x, y, r } = HERO.avatar;
  const size = titleSize(`${look.title[0]} ${look.title[1]}`);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: INTER,
        filter:
          focusAway > 0 ? `blur(${(focusAway * 1.6).toFixed(2)}px)` : undefined,
        opacity: 1 - 0.18 * focusAway,
      }}
    >
      {ring > 0 && ring < 1 ? (
        <div
          style={{
            position: "absolute",
            left: x - r,
            top: y - r,
            width: r * 2,
            height: r * 2,
            borderRadius: "50%",
            border: `4px solid ${tint(look.color, 0.5 * (1 - ring))}`,
            transform: `scale(${(1 + ring * 0.9).toFixed(3)})`,
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: x - r,
          top: y - r,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background: look.color,
          boxShadow: `0 16px 40px -14px ${tint(look.color, 0.7)}`,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          transform: `scale(${scale.toFixed(4)})`,
        }}
      >
        {look.avatar === "person" ? (
          <PersonGlyph size={50} />
        ) : (
          <div style={{ width: 63, height: 41 }}>
            <AntMark />
          </div>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: x + r + HERO.badgeGap,
          top: y - 24,
          height: 48,
          padding: "0 22px",
          borderRadius: 999,
          background: tint(look.color, 0.12),
          color: look.deep,
          fontSize: 22,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 10,
          ...wordIn(t, timing.avatarAt + 0.25),
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            background: look.color,
          }}
        />
        {look.badge ?? "AI employee"}
      </div>
      <div
        style={{
          position: "absolute",
          left: x - r,
          top: HERO.titleTop,
          width: HERO.titleWidth,
          fontSize: size,
          fontWeight: 800,
          letterSpacing: `${TRACKING}em`,
          lineHeight: 1,
          color: INK,
          whiteSpace: "nowrap",
        }}
      >
        <span style={wordIn(t, timing.headlineAt)}>{look.title[0]}</span>{" "}
        <span style={wordIn(t, timing.headlineAt + 0.12)}>{look.title[1]}</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: x - r,
          top: HERO.sublineTop,
          width: HERO.titleWidth,
          fontSize: HERO.sublineSize,
          fontWeight: 500,
          lineHeight: 1.3,
          color: MUTED,
          textWrap: "balance",
          ...wordIn(t, timing.sublineAt),
        }}
      >
        {look.subline}
      </div>
    </div>
  );
};
