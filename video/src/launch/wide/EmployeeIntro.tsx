import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { AVATAR, BEAT, CAMERA, cameraScale } from "./beat.ts";

const INK = "#17151f";
const MUTED = "#5d5a6b";
const BLUE = "hsl(217 91% 60%)";

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

/** The employee steps forward: avatar, "AI employee", a big name for the job, one plain line. */
export const EmployeeIntro: React.FC<{ t: number }> = ({ t }) => {
  const pop = progress(t, BEAT.avatarAt - 0.05, 0.55);
  if (pop <= 0) return null;
  const scale = easeOutBack(pop);
  const ring = progress(t, BEAT.avatarAt, 1.1);
  const focusAway = smoothstep(4.8, 5.6, t);
  // Out of focus while the camera is close on the rows, like a real lens.
  const close = (cameraScale(t) - 1) / (CAMERA.close - 1);
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
            border: `4px solid hsl(217 91% 60% / ${(0.5 * (1 - ring)).toFixed(3)})`,
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
          background: BLUE,
          boxShadow: "0 16px 40px -14px hsl(217 91% 50% / 0.7)",
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
          background: "hsl(217 91% 60% / 0.12)",
          color: "hsl(217 80% 46%)",
          fontSize: 22,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 10,
          ...wordIn(t, BEAT.avatarAt + 0.25),
        }}
      >
        <span
          style={{ width: 10, height: 10, borderRadius: 5, background: BLUE }}
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
        <span style={wordIn(t, 2.5)}>Finds</span>
        <br />
        <span style={wordIn(t, 2.62)}>customers.</span>
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
          ...wordIn(t, 3.05),
        }}
      >
        Finds businesses near you that need what you sell.
      </div>
    </div>
  );
};
