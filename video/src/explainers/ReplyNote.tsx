import { INTER } from "../launch/fonts";
import { easeOutExpo, progress, smoothstep } from "../launch/math.ts";
import type { Rect } from "./approve.ts";

/** A reply under the email it answers: who replied, and what they said. Leaves with the email card. */
export const ReplyNote: React.FC<{
  t: number;
  at: number;
  /** The email card hands over from here; the note goes with it. */
  until: number;
  rect: Rect;
  label: string;
  text: string;
}> = ({ t, at, until, rect, label, text }) => {
  const e = easeOutExpo(progress(t, at, 0.5));
  const out = smoothstep(until - 0.05, until + 0.35, t);
  if (e <= 0 || out >= 1) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        fontFamily: INTER,
        opacity: e * (1 - out),
        transform: `translateY(${((1 - e) * 16 - 30 * out).toFixed(2)}px)`,
      }}
    >
      <div
        style={{
          fontSize: 19,
          fontWeight: 600,
          color: "#6a6780",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "inline-block",
          padding: "16px 22px",
          borderRadius: 22,
          background: "#f3f1f8",
          fontSize: 26,
          fontWeight: 500,
          color: "#17151f",
        }}
      >
        {text}
      </div>
    </div>
  );
};
