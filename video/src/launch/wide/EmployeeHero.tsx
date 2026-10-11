import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { AVATAR, CAMERA, type CameraTiming, cameraScale } from "./beat.ts";
import type { HeroLook } from "./employees.ts";

const INK = "#17151f";
const MUTED = "#5d5a6b";

export type HeroTiming = {
  avatarAt: number;
  headlineAt: number;
  sublineAt: number;
  /** When attention moves to the work card; the hero softens. */
  focusFrom?: number;
};

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

function wordIn(t: number, at: number): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, 0.6));
  return {
    display: "inline-block",
    opacity: e,
    transform: `translateY(${((1 - e) * 28).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 12).toFixed(2)}px)` : undefined,
  };
}

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

/** An employee steps forward: avatar, "AI employee", the job in two big lines, one plain sentence. */
export const EmployeeHero: React.FC<{
  t: number;
  look: HeroLook;
  timing: HeroTiming;
  camera?: CameraTiming;
}> = ({ t, look, timing, camera }) => {
  const pop = progress(t, timing.avatarAt - 0.05, 0.55);
  if (pop <= 0) return null;
  const scale = easeOutBack(pop);
  const ring = progress(t, timing.avatarAt, 1.1);
  const focusAway =
    timing.focusFrom === undefined
      ? 0
      : smoothstep(timing.focusFrom, timing.focusFrom + 0.8, t);
  const close = camera ? (cameraScale(t, camera) - 1) / (CAMERA.close - 1) : 0;
  const blur = focusAway * 1.6 + close * 5;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: INTER,
        filter: blur > 0 ? `blur(${blur.toFixed(2)}px)` : undefined,
        opacity: 1 - 0.18 * focusAway,
      }}
    >
      {ring > 0 && ring < 1 ? (
        <div
          style={{
            position: "absolute",
            left: AVATAR.x - AVATAR.r,
            top: AVATAR.y - AVATAR.r,
            width: AVATAR.r * 2,
            height: AVATAR.r * 2,
            borderRadius: "50%",
            border: `4px solid ${tint(look.color, 0.5 * (1 - ring))}`,
            transform: `scale(${(1 + ring * 0.9).toFixed(3)})`,
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: AVATAR.x - AVATAR.r,
          top: AVATAR.y - AVATAR.r,
          width: AVATAR.r * 2,
          height: AVATAR.r * 2,
          borderRadius: "50%",
          background: look.color,
          boxShadow: `0 16px 40px -14px ${tint(look.color, 0.7)}`,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          transform: `scale(${scale.toFixed(4)})`,
        }}
      >
        <div style={{ width: 76, height: 50 }}>
          <AntMark />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: AVATAR.x + AVATAR.r + 26,
          top: AVATAR.y - 24,
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
        AI employee
      </div>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 384,
          fontSize: 112,
          fontWeight: 800,
          letterSpacing: "-0.045em",
          lineHeight: 1,
          color: INK,
        }}
      >
        <span style={wordIn(t, timing.headlineAt)}>{look.title[0]}</span>
        <br />
        <span style={wordIn(t, timing.headlineAt + 0.12)}>{look.title[1]}</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 640,
          width: 600,
          fontSize: 38,
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
