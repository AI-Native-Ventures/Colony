import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { CALL, type Call, type CallTiming, callClock } from "./call.ts";
import { EMAIL_CARD } from "./email.ts";
import { TONES } from "./employees.ts";

const AMBER = TONES.amber;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const BARS = 34;

function tint(alpha: number): string {
  return AMBER.color.replace(")", ` / ${alpha})`);
}

/** Words of a line shown so far, as if heard live. */
function heard(
  text: string,
  t: number,
  at: number,
  wordsPerSecond = 7,
): string {
  const words = text.split(" ");
  const n = Math.max(
    0,
    Math.min(words.length, Math.floor((t - at) * wordsPerSecond) + 1),
  );
  return t < at ? "" : words.slice(0, n).join(" ");
}

/** The sales employee on a call for the business: live timer, voice bars, what is said, a booked meeting. */
export const CallCard: React.FC<{
  t: number;
  timing: CallTiming;
  /** Defaults are the launch film's call for Bright Plumbing. */
  call?: Call;
  business?: string;
  /** The timer stops when the meeting is booked; the film's runs on. */
  clockStops?: boolean;
}> = ({
  t,
  timing,
  call = CALL,
  business = "Bright Plumbing",
  clockStops = false,
}) => {
  const enter = easeOutExpo(progress(t, timing.callIn, 0.7));
  if (enter <= 0) return null;
  const connected = t >= timing.connectAt;
  const booked = easeOutExpo(progress(t, timing.bookedAt, 0.6));
  const talking = connected && t < timing.bookedAt;
  const ring = connected ? 0 : 0.5 + 0.5 * Math.sin(t * 14);
  return (
    <div
      style={{
        position: "absolute",
        left: EMAIL_CARD.x,
        top: EMAIL_CARD.y,
        width: EMAIL_CARD.w,
        height: EMAIL_CARD.h,
        borderRadius: 32,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxShadow: "0 50px 100px -50px hsl(30 60% 30% / 0.4)",
        fontFamily: INTER,
        color: INK,
        opacity: enter,
        transform: `translateY(${((1 - enter) * 40).toFixed(2)}px)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 52,
          top: 46,
          fontSize: 52,
          fontWeight: 800,
          letterSpacing: "-0.03em",
        }}
      >
        Outreach.
      </div>
      <div
        style={{
          position: "absolute",
          left: 52,
          top: 116,
          fontSize: 24,
          color: MUTED,
        }}
      >
        Calls to new customers, for your business.
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 54,
          height: 64,
          padding: "0 26px",
          borderRadius: 999,
          background: tint(0.14),
          color: AMBER.deep,
          fontSize: 30,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            background: AMBER.color,
            opacity:
              booked > 0 ? 1 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 6)),
          }}
        />
        {booked > 0 ? "1 meeting booked" : "On a call"}
      </div>
      <div
        style={{
          position: "absolute",
          left: 52,
          right: 48,
          top: 196,
          height: 64,
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <span
          style={{
            width: 60,
            height: 60,
            borderRadius: 30,
            background: AMBER.color,
            color: "#ffffff",
            fontSize: 28,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            boxShadow: connected
              ? undefined
              : `0 0 0 ${(10 * ring).toFixed(1)}px ${tint(0.25)}`,
          }}
        >
          {call.name[0]}
        </span>
        <span style={{ fontSize: 30, fontWeight: 650 }}>{call.name}</span>
        <span style={{ fontSize: 26, color: MUTED }}>at {call.company}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            height: 40,
            padding: "0 16px",
            borderRadius: 999,
            border: `1.5px solid ${LINE}`,
            fontSize: 21,
            fontWeight: 600,
            color: MUTED,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          Phone
        </span>
        <span
          style={{
            minWidth: 92,
            fontSize: 28,
            fontWeight: 700,
            color: AMBER.deep,
            fontVariantNumeric: "tabular-nums",
            textAlign: "right",
          }}
        >
          {connected
            ? callClock(clockStops ? Math.min(t, timing.bookedAt) : t, timing)
            : "Calling…"}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          top: 290,
          height: 1.5,
          background: LINE,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 52,
          right: 52,
          top: 318,
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {Array.from({ length: BARS }, (_, k) => {
          const level = talking
            ? 0.25 +
              0.75 *
                Math.abs(
                  Math.sin(t * 9 + k * 0.7) * Math.cos(t * 4.3 + k * 0.31),
                )
            : 0.12;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars that never reorder
              key={k}
              style={{
                flex: 1,
                height: `${(level * 100).toFixed(1)}%`,
                borderRadius: 3,
                background: tint(0.35 + 0.5 * level),
              }}
            />
          );
        })}
      </div>
      {call.lines.map((line, i) => {
        const at = i === 0 ? timing.bubble1At : timing.bubble2At;
        const shown = heard(line.text, t, at);
        if (!shown) return null;
        const ours = line.who === "us";
        const e = easeOutExpo(progress(t, at, 0.45));
        return (
          <div
            key={line.text}
            style={{
              position: "absolute",
              top: i === 0 ? 410 : 566,
              left: ours ? 52 : undefined,
              right: ours ? undefined : 52,
              maxWidth: 640,
              opacity: e,
              transform: `translateY(${((1 - e) * 14).toFixed(2)}px)`,
            }}
          >
            <div
              style={{
                fontSize: 19,
                fontWeight: 600,
                color: MUTED,
                marginBottom: 8,
                textAlign: ours ? "left" : "right",
              }}
            >
              {ours ? business : call.name}
            </div>
            <div
              style={{
                padding: "16px 22px",
                borderRadius: 22,
                background: ours ? tint(0.12) : "#f3f1f8",
                fontSize: 26,
                fontWeight: 500,
                lineHeight: 1.38,
                color: INK,
              }}
            >
              {shown}
            </div>
          </div>
        );
      })}
      {booked > 0 ? (
        <div
          style={{
            position: "absolute",
            left: 52,
            top: 676,
            height: 60,
            padding: "0 24px",
            borderRadius: 999,
            background: AMBER.color,
            color: "#ffffff",
            fontSize: 26,
            fontWeight: 750,
            display: "flex",
            alignItems: "center",
            gap: 12,
            opacity: booked,
            transform: `scale(${(0.85 + 0.15 * booked).toFixed(4)})`,
            transformOrigin: "0 50%",
          }}
        >
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
            <rect
              x="3.5"
              y="5"
              width="17"
              height="15"
              rx="3"
              fill="none"
              stroke="#fff"
              strokeWidth="2.2"
            />
            <path
              d="M3.5 10h17M8 3v4M16 3v4"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          {call.booked}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          right: 52,
          top: 690,
          fontSize: 20,
          color: MUTED,
          opacity: smoothstep(timing.bookedAt + 0.2, timing.bookedAt + 0.6, t),
        }}
      >
        Added to your calendar
      </div>
    </div>
  );
};
