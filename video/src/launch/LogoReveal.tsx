import { AntMark } from "../brand/AntMark";
import { INTER } from "./fonts";
import { easeOutExpo, progress, smoothstep } from "./math.ts";
import { LOGO_RECT, T_LOGO_IN, T_TEXT_1, T_TEXT_2 } from "./timeline.ts";

const VIOLET = "hsl(258 90% 66%)";

function reveal(t: number, at: number): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, 0.7));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 34).toFixed(2)}px)`,
    filter: `blur(${((1 - e) * 10).toFixed(2)}px)`,
  };
}

/** The crisp brand mark taking over from the swarm, a light pulse, and "Introducing Colony." */
export const LogoReveal: React.FC<{ t: number }> = ({ t }) => {
  const logoIn = smoothstep(T_LOGO_IN, T_LOGO_IN + 0.4, t);
  const pulse = progress(t, T_LOGO_IN + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow =
    0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    0.22 * smoothstep(T_LOGO_IN, T_LOGO_IN + 0.6, t);
  const ringAlpha = pulse > 0 ? 0.45 * (1 - ring) : 0;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - 520,
          top: LOGO_RECT.cy - 520,
          width: 1040,
          height: 1040,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, hsl(258 90% 66% / 0.55) 0%, hsl(258 90% 66% / 0.12) 38%, transparent 70%)",
          opacity: glow,
          transform: `scale(${(0.7 + 0.35 * ring).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - 300,
          top: LOGO_RECT.cy - 300,
          width: 600,
          height: 600,
          borderRadius: "50%",
          border: `3px solid hsl(258 90% 76% / ${ringAlpha.toFixed(3)})`,
          transform: `scale(${(0.6 + 1.1 * ring).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - LOGO_RECT.width / 2,
          top: LOGO_RECT.cy - LOGO_RECT.height / 2,
          width: LOGO_RECT.width,
          height: LOGO_RECT.height,
          color: VIOLET,
          opacity: logoIn,
          filter: `drop-shadow(0 0 ${(24 * logoIn).toFixed(1)}px hsl(258 90% 66% / 0.6))`,
        }}
      >
        <AntMark />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: LOGO_RECT.cy + LOGO_RECT.height / 2 + 70,
          textAlign: "center",
          fontFamily: INTER,
        }}
      >
        <div
          style={{
            fontSize: 50,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.72)",
            letterSpacing: "0.01em",
            ...reveal(t, T_TEXT_1),
          }}
        >
          Introducing
        </div>
        <div
          style={{
            fontSize: 150,
            fontWeight: 800,
            color: "#fff",
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
            marginTop: 6,
            ...reveal(t, T_TEXT_2),
          }}
        >
          Colony.
        </div>
      </div>
    </>
  );
};
