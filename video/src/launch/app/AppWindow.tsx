import { SCENES } from "../film.ts";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { TITLE_BAR, UI, WINDOW } from "./ui.ts";

/** The Colony desktop app, floating over the dark world with a slight tilt. */
export const AppWindow: React.FC<{ t: number; children: React.ReactNode }> = ({
  t,
  children,
}) => {
  const enter = easeOutExpo(progress(t, SCENES.business.start - 0.25, 0.9));
  const exit = smoothstep(SCENES.end.start, SCENES.end.start + 0.6, t);
  if (enter <= 0.001 || exit >= 0.999) return null;
  const drift = Math.sin(t * 0.6);
  const rx = 7 - 3 * enter + drift * 0.4;
  const ry = -9 + 3.5 * enter + drift * 0.6;
  const y = (1 - enter) * 220 - exit * 90;
  const scale = (0.86 + 0.14 * enter) * (1 - 0.12 * exit);
  const sweep = progress(t, SCENES.business.start + 0.15, 1.5);
  return (
    <div
      style={{
        position: "absolute",
        left: WINDOW.left,
        top: WINDOW.top,
        width: WINDOW.width,
        height: WINDOW.height,
        opacity: enter * (1 - exit),
        transform: `perspective(2400px) translateY(${y.toFixed(2)}px) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${scale.toFixed(4)})`,
        transformOrigin: "50% 40%",
        filter: exit > 0 ? `blur(${(exit * 8).toFixed(2)}px)` : undefined,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 40,
          background: UI.page,
          overflow: "hidden",
          boxShadow:
            "0 80px 160px -50px hsl(258 90% 40% / 0.65), 0 0 0 1.5px rgb(255 255 255 / 0.55)",
          fontFamily: INTER,
          color: UI.ink,
        }}
      >
        <div
          style={{
            height: TITLE_BAR,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "0 28px",
            background: "linear-gradient(#ece8f6, #e4dff1)",
            borderBottom: `1px solid ${UI.line}`,
          }}
        >
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span
              key={c}
              style={{ width: 18, height: 18, borderRadius: 9, background: c }}
            />
          ))}
          <span
            style={{
              marginLeft: 18,
              fontSize: 27,
              fontWeight: 800,
              letterSpacing: "-0.02em",
            }}
          >
            Colony
          </span>
        </div>
        <div
          style={{
            position: "absolute",
            top: TITLE_BAR,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        >
          {children}
        </div>
        {sweep > 0 && sweep < 1 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background: `linear-gradient(105deg, transparent ${(sweep * 140 - 40).toFixed(1)}%, rgb(255 255 255 / 0.5) ${(sweep * 140 - 20).toFixed(1)}%, transparent ${(sweep * 140).toFixed(1)}%)`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
};
