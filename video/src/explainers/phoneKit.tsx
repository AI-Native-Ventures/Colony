import { AntMark } from "../brand/AntMark";
import { Cursor } from "../launch/app/Cursor";
import {
  easeInOutCubic,
  easeOutExpo,
  progress,
  smoothstep,
} from "../launch/math.ts";
import type { Tone } from "../launch/wide/employees.ts";
import { PHONE_CARD, PHONE_PAD, PINNED, pinnedCursorKeys } from "./phone.ts";
import { Tick } from "./RisePostsCard";

const INK = "#17151f";
const MUTED = "#6a6780";

export function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

/** A phone screen's big title, top left. Card pixels. */
export const PhoneTitle: React.FC<{ text: string; opacity?: number }> = ({
  text,
  opacity = 1,
}) => (
  <div
    style={{
      position: "absolute",
      left: PHONE_PAD,
      top: 36,
      fontSize: 52,
      fontWeight: 800,
      letterSpacing: "-0.03em",
      color: INK,
      opacity,
    }}
  >
    {text}
  </div>
);

/** The status pill, top right; `done` shows a tick. Card pixels. */
export const PhonePill: React.FC<{
  label: string;
  tone: Tone;
  opacity: number;
  done?: boolean;
  /** 0 to 1: a little swell when the status changes. */
  bump?: number;
}> = ({ label, tone, opacity, done = false, bump = 0 }) =>
  opacity <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        right: 40,
        top: 40,
        height: 60,
        padding: "0 26px",
        borderRadius: 999,
        background: tint(tone.color, done ? 0.18 : 0.12),
        color: tone.deep,
        fontSize: 26,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        gap: 10,
        opacity,
        transform: `scale(${(1 + 0.08 * bump).toFixed(4)})`,
        transformOrigin: "right center",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {done ? <Tick size={24} color={tone.deep} /> : null}
      {label}
    </div>
  );

/** "You asked" and the request, typed as the voice says it. Card pixels. */
export const PhoneRequest: React.FC<{
  t: number;
  text: string;
  from: number;
  cps: number;
  /** When the chip and the empty line appear. */
  showFrom: number;
  tone: Tone;
  top?: number;
  label?: string;
}> = ({
  t,
  text,
  from,
  cps,
  showFrom,
  tone,
  top = 124,
  label = "You asked",
}) => {
  const shown = easeOutExpo(progress(t, showFrom, 0.4));
  if (shown <= 0) return null;
  const typed = Math.max(
    0,
    Math.min(text.length, Math.floor((t - from) * cps)),
  );
  const caretOn =
    (typed > 0 && typed < text.length) ||
    (t < from + 0.1 && t > showFrom + 0.3);
  return (
    <div style={{ opacity: shown }}>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top,
          height: 40,
          padding: "0 18px",
          borderRadius: 999,
          background: "#f4f3f8",
          color: MUTED,
          fontSize: 22,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
        }}
      >
        {label}
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: top + 52,
          width: PHONE_CARD.w - 2 * PHONE_PAD,
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: "-0.01em",
          color: INK,
        }}
      >
        {text.slice(0, typed)}
        {caretOn ? (
          <span
            style={{
              display: "inline-block",
              width: 3,
              height: 34,
              marginLeft: 2,
              verticalAlign: "-6px",
              background: tone.color,
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

export type PinnedTiming = { approveIn: number; click: number; doneAt: number };

/** The button pinned to the card's foot over a fade of what scrolls behind it. Card pixels. */
export const PinnedButton: React.FC<{
  t: number;
  tone: Tone;
  idle: string;
  done: string;
  timing: PinnedTiming;
  /** A ring that keeps pulsing while the button waits for the owner. */
  pulse?: boolean;
}> = ({ t, tone, idle, done: doneLabel, timing, pulse = false }) => {
  const show = easeOutExpo(progress(t, timing.approveIn, 0.5));
  if (show <= 0) return null;
  const wait = t - timing.approveIn - 0.5;
  const ring = pulse && wait > 0 ? (wait % 1.4) / 1.4 : 0;
  const pressed = t >= timing.click && t < timing.click + 0.14 ? 0.97 : 1;
  const done = t >= timing.doneAt;
  const left = PINNED.x - PHONE_CARD.x;
  const top = PINNED.y - PHONE_CARD.y;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: top - 30,
          bottom: 0,
          background:
            "linear-gradient(to bottom, rgb(255 255 255 / 0), #ffffff 45%)",
          opacity: show,
        }}
      />
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: PINNED.w,
          height: PINNED.h,
          borderRadius: 999,
          background: done ? tint(tone.color, 0.16) : tone.color,
          color: done ? tone.deep : "#ffffff",
          boxShadow: done
            ? undefined
            : ring > 0
              ? `0 0 0 ${(14 * ring).toFixed(2)}px ${tint(tone.color, 0.3 * (1 - ring))}, 0 22px 40px -20px ${tint(tone.color, 0.9)}`
              : `0 22px 40px -20px ${tint(tone.color, 0.9)}`,
          fontSize: 32,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          opacity: show,
          transform: `translateY(${((1 - show) * 40).toFixed(2)}px) scale(${pressed})`,
        }}
      >
        {done ? <Tick size={30} color={tone.deep} /> : null}
        {done ? doneLabel : idle}
      </div>
    </>
  );
};

/** The owner's pointer onto the pinned button. Frame pixels. */
export const PinnedCursor: React.FC<{
  t: number;
  timing: { cursorFrom: number; click: number };
  /** Clicks it makes; the pinned button's by default. */
  clicks?: readonly number[];
}> = ({ t, timing, clicks }) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.click + 0.7, timing.click + 1.1, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={pinnedCursorKeys(timing)}
      clicks={clicks ?? [timing.click]}
      opacity={opacity}
    />
  );
};

/** How far a push from one screen to the next has gone at `t`, 0 to 1. */
export function pushed(t: number, at: number, seconds = 0.45): number {
  return easeInOutCubic(progress(t, at, seconds));
}

/**
 * Two phone screens and a push between them at `at`: the first slides out
 * to the left, the second in from the right, as a phone app does. Each
 * screen is the whole card, in card pixels.
 */
export const PhonePush: React.FC<{
  t: number;
  at: number;
  first: React.ReactNode;
  second: React.ReactNode;
  seconds?: number;
}> = ({ t, at, first, second, seconds = 0.45 }) => {
  const p = pushed(t, at, seconds);
  const screen: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: PHONE_CARD.w,
    height: PHONE_CARD.h,
  };
  return (
    <>
      {p < 1 ? (
        <div
          style={{
            ...screen,
            transform: `translateX(${(-p * PHONE_CARD.w * 0.3).toFixed(2)}px)`,
            opacity: 1 - 0.6 * p,
          }}
        >
          {first}
        </div>
      ) : null}
      {p > 0 ? (
        <div
          style={{
            ...screen,
            background: "#ffffff",
            transform: `translateX(${((1 - p) * PHONE_CARD.w).toFixed(2)}px)`,
            boxShadow:
              p < 1 ? "-24px 0 48px -24px rgb(23 21 31 / 0.25)" : undefined,
          }}
        >
          {second}
        </div>
      ) : null}
    </>
  );
};

/** An employee's round avatar: the ant on its colour, with a soft shadow. */
export const PhoneAvatar: React.FC<{ color: string; size: number }> = ({
  color,
  size,
}) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      background: color,
      display: "grid",
      placeItems: "center",
      boxShadow: `0 14px 30px -14px ${tint(color, 0.8)}`,
      flexShrink: 0,
    }}
  >
    <span
      style={{
        display: "flex",
        width: size * 0.62,
        height: size * 0.41,
        color: "#ffffff",
      }}
    >
      <AntMark />
    </span>
  </span>
);
