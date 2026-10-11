import { Cursor } from "../launch/app/Cursor";
import { INTER } from "../launch/fonts";
import { easeOutExpo, progress, smoothstep } from "../launch/math.ts";
import type { Tone } from "../launch/wide/employees.ts";
import { approveKeys, type Rect } from "./approve.ts";

const INK = "#17151f";
const MUTED = "#6a6780";

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

export function Tick({ size, color }: { size: number; color: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M5 12.5l4.2 4.2L19 7"
        fill="none"
        stroke={color}
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "You asked" and the owner's words, typed as they are said. Positioned in its parent's pixels. */
export const RequestLine: React.FC<{
  t: number;
  x: number;
  y: number;
  text: string;
  from: number;
  cps: number;
  /** When the empty line (chip and caret) first shows. */
  showFrom: number;
  tone: Tone;
  label?: string;
}> = ({ t, x, y, text, from, cps, showFrom, tone, label = "You asked" }) => {
  const shown = smoothstep(showFrom, showFrom + 0.3, t);
  if (shown <= 0) return null;
  const typed = Math.max(
    0,
    Math.min(text.length, Math.floor((t - from) * cps)),
  );
  const caret = typed < text.length;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontFamily: INTER,
        fontSize: 28,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        color: INK,
        opacity: shown,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          flex: "none",
          height: 40,
          padding: "0 16px",
          borderRadius: 999,
          background: "#f4f3f8",
          color: MUTED,
          fontSize: 20,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
        }}
      >
        {label}
      </span>
      <span>
        {text.slice(0, typed)}
        {caret ? (
          <span
            style={{
              display: "inline-block",
              width: 3,
              height: 32,
              marginLeft: 2,
              verticalAlign: "-5px",
              background: tone.color,
            }}
          />
        ) : null}
      </span>
    </div>
  );
};

/** The owner's yes: a button that appears, is pressed, then says it is done. Rect in panel pixels. */
export const ApproveButton: React.FC<{
  t: number;
  rect: Rect;
  tone: Tone;
  idle: string;
  done: string;
  timing: { approveIn: number; click: number; doneAt: number };
}> = ({ t, rect, tone, idle, done, timing }) => {
  const appear = easeOutExpo(progress(t, timing.approveIn, 0.45));
  if (appear <= 0) return null;
  const isDone = t >= timing.doneAt;
  const pressed = t >= timing.click && t < timing.click + 0.14 ? 0.96 : 1;
  const bump = isDone ? 1 - progress(t, timing.doneAt, 0.4) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: 999,
        background: isDone ? tint(tone.color, 0.16) : tone.color,
        color: isDone ? tone.deep : "#ffffff",
        boxShadow: isDone
          ? undefined
          : `0 18px 30px -16px ${tint(tone.color, 0.9)}`,
        fontFamily: INTER,
        fontSize: 26,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: appear,
        transform: `scale(${((0.85 + 0.15 * appear) * pressed * (1 + 0.06 * bump)).toFixed(4)})`,
      }}
    >
      {isDone ? <Tick size={24} color={tone.deep} /> : null}
      {isDone ? done : idle}
    </div>
  );
};

/** The owner's pointer onto a yes button. */
export const ApprovePointer: React.FC<{
  t: number;
  rect: Rect;
  timing: { cursorFrom: number; click: number };
}> = ({ t, rect, timing }) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.click + 0.7, timing.click + 1.1, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={approveKeys(rect, timing)}
      clicks={[timing.click]}
      opacity={opacity}
    />
  );
};
