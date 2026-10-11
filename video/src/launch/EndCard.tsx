import { AntMark } from "../brand/AntMark";
import { SCENES } from "./film.ts";
import { INTER } from "./fonts";
import { easeOutExpo, progress, smoothstep } from "./math.ts";

const LOGO = { cx: 540, cy: 760, width: 520 };
const LOGO_H = LOGO.width * (309 / 466);
const LOGO_AT = SCENES.end.start + 0.5;

function reveal(t: number, at: number): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, 0.7));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 30).toFixed(2)}px)`,
    filter: e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
  };
}

/** Logo, name, promise and the way in, timed to the last voice line. */
export const EndCard: React.FC<{ t: number }> = ({ t }) => {
  if (t < SCENES.end.start) return null;
  const logoIn = smoothstep(LOGO_AT, LOGO_AT + 0.45, t);
  const pulse = progress(t, LOGO_AT + 0.05, 1.2);
  const glow =
    0.5 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    0.25 * smoothstep(LOGO_AT, LOGO_AT + 0.7, t);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: INTER }}>
      <div
        style={{
          position: "absolute",
          left: LOGO.cx - 480,
          top: LOGO.cy - 480,
          width: 960,
          height: 960,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, hsl(258 90% 66% / 0.5) 0%, hsl(258 90% 66% / 0.1) 40%, transparent 70%)",
          opacity: glow,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: LOGO.cx - LOGO.width / 2,
          top: LOGO.cy - LOGO_H / 2,
          width: LOGO.width,
          height: LOGO_H,
          color: "hsl(258 90% 66%)",
          opacity: logoIn,
          transform: `scale(${(0.9 + 0.1 * logoIn).toFixed(4)})`,
          filter: `drop-shadow(0 0 ${(22 * logoIn).toFixed(1)}px hsl(258 90% 66% / 0.6))`,
        }}
      >
        <AntMark />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 980,
          textAlign: "center",
          color: "#fff",
          fontSize: 150,
          fontWeight: 800,
          letterSpacing: "-0.045em",
          lineHeight: 1.05,
          ...reveal(t, SCENES.end.start + 1.0),
        }}
      >
        Colony.
      </div>
      <div
        style={{
          position: "absolute",
          left: 90,
          right: 140,
          top: 1170,
          textAlign: "center",
          color: "rgb(236 235 243 / 0.82)",
          fontSize: 46,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          ...reveal(t, SCENES.end.start + 1.5),
        }}
      >
        Your business. Your AI employees.
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 1278,
          display: "flex",
          justifyContent: "center",
          ...reveal(t, 27.6),
        }}
      >
        <div
          style={{
            padding: "20px 44px",
            borderRadius: 999,
            background: "hsl(258 90% 66%)",
            color: "#fff",
            fontSize: 40,
            fontWeight: 700,
            boxShadow: "0 20px 60px -20px hsl(258 90% 60% / 0.8)",
          }}
        >
          Early access is open
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 1410,
          textAlign: "center",
          color: "rgb(236 235 243 / 0.65)",
          fontSize: 34,
          fontWeight: 600,
          ...reveal(t, 27.9),
        }}
      >
        colony.ainative.ventures
      </div>
    </div>
  );
};
