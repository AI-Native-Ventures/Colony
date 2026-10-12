import { AntMark } from "../../brand/AntMark";
import { Cursor } from "../app/Cursor";
import { INTER } from "../fonts";
import { easeOutExpo, lerpAngle, progress, smoothstep } from "../math.ts";
import { OWNER, TONES } from "./employees.ts";
import { type Path, walkState } from "./walk.ts";
import { WorkerAnt } from "./WorkerAnt";
import {
  APPROVE_BUTTON,
  approvedAt,
  outcomeAt,
  SEND_BACK_BUTTON,
  YES_CARD,
  YES_ROW_H,
  YES_ROWS,
  type YesTiming,
  yesCarryPath,
  yesCarryStart,
  yesCursorKeys,
  yesLandsAt,
  yesRowY,
} from "./yes.ts";

export type InboxTiming = YesTiming & { cardIn: number };

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = OWNER.color;

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

function Check({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M5 12.5l4.2 4.2L19 7"
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The owner's inbox: one card per employee, then one tap approves them all. */
export const InboxCard: React.FC<{ t: number; timing: InboxTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const lastApproved = approvedAt(YES_ROWS.length - 1, timing);
  const cleared = smoothstep(lastApproved + 0.15, lastApproved + 0.5, t);
  const waiting = YES_ROWS.filter(
    (_, i) => t >= yesLandsAt(i, timing) && t < approvedAt(i, timing),
  ).length;
  const firstIn = yesLandsAt(0, timing);
  const counting = smoothstep(firstIn - 0.1, firstIn + 0.2, t);
  const press = t >= timing.click && t < timing.click + 0.14 ? 1 : 0;
  const approved = t >= timing.click;
  return (
    <div
      style={{
        position: "absolute",
        left: YES_CARD.x,
        top: YES_CARD.y,
        width: YES_CARD.w,
        height: YES_CARD.h,
        borderRadius: 32,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxShadow: "0 50px 100px -50px hsl(258 60% 40% / 0.45)",
        fontFamily: INTER,
        color: INK,
        opacity: enter,
        transform: `translateX(${((1 - enter) * 90).toFixed(2)}px)`,
        filter:
          enter < 1 ? `blur(${((1 - enter) * 10).toFixed(2)}px)` : undefined,
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
        Inbox.
      </div>
      <div
        style={{
          position: "absolute",
          left: 52,
          top: 116,
          fontSize: 24,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            background: VIOLET,
            opacity: counting * (1 - cleared),
          }}
        />
        <span
          style={{
            fontWeight: 600,
            color: INK,
            opacity: counting * (1 - cleared),
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {waiting === 1
            ? "1 card is waiting for your call."
            : `${waiting} cards are waiting for your call.`}
        </span>
        <span
          style={{
            position: "absolute",
            left: 0,
            whiteSpace: "nowrap",
            color: MUTED,
            opacity: cleared,
          }}
        >
          Nothing is waiting for you. Your team is on it.
        </span>
      </div>
      {YES_ROWS.map((row, i) => {
        const top = yesRowY(i) - YES_CARD.y;
        const tone = TONES[row.who];
        const arrived = easeOutExpo(progress(t, yesLandsAt(i, timing), 0.45));
        const ok = approvedAt(i, timing);
        const flash = t >= ok ? 1 - progress(t, ok, 0.7) : 0;
        const isApproved = t >= ok;
        const showOutcome = t >= outcomeAt(i, timing);
        return (
          <div
            key={row.who}
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              top,
              height: YES_ROW_H,
              borderRadius: 18,
              background:
                flash > 0 ? tint(tone.color, 0.12 * flash) : undefined,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                bottom: -8,
                height: 1.5,
                background: LINE,
              }}
            />
            {arrived <= 0 ? (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: 86,
                    top: 26,
                    width: 360,
                    height: 20,
                    borderRadius: 10,
                    background: "#f3f1f8",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: 86,
                    top: 56,
                    width: 140,
                    height: 14,
                    borderRadius: 7,
                    background: "#f6f4fa",
                  }}
                />
              </>
            ) : (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: arrived,
                  transform: `translateX(${((1 - arrived) * -24).toFixed(2)}px)`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 86,
                    top: 14,
                    fontSize: 28,
                    fontWeight: 650,
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.title}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 86,
                    top: 52,
                    fontSize: 21,
                    color: MUTED,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: tone.color,
                    }}
                  />
                  {row.kind}
                </div>
                <div
                  style={{
                    position: "absolute",
                    right: 18,
                    top: 24,
                    height: 44,
                    padding: "0 18px",
                    borderRadius: 999,
                    background: isApproved
                      ? tint(tone.color, 0.14)
                      : tint(VIOLET, 0.12),
                    color: isApproved ? tone.deep : OWNER.deep,
                    fontSize: 21,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    transform: `scale(${(1 + 0.1 * flash).toFixed(4)})`,
                  }}
                >
                  {isApproved ? <Check color={tone.deep} /> : null}
                  {showOutcome
                    ? row.outcome
                    : isApproved
                      ? "Approved"
                      : "Waiting"}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: SEND_BACK_BUTTON.x - YES_CARD.x,
          top: SEND_BACK_BUTTON.y - YES_CARD.y,
          width: SEND_BACK_BUTTON.w,
          height: SEND_BACK_BUTTON.h,
          borderRadius: 999,
          border: `1.5px solid ${LINE}`,
          color: MUTED,
          fontSize: 25,
          fontWeight: 650,
          display: "grid",
          placeItems: "center",
          opacity: 1 - 0.6 * smoothstep(timing.click, timing.click + 0.3, t),
        }}
      >
        Send it back
      </div>
      <div
        style={{
          position: "absolute",
          left: APPROVE_BUTTON.x - YES_CARD.x,
          top: APPROVE_BUTTON.y - YES_CARD.y,
          width: APPROVE_BUTTON.w,
          height: APPROVE_BUTTON.h,
          borderRadius: 999,
          background: VIOLET,
          color: "#ffffff",
          fontSize: 27,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: `0 18px 36px -16px ${tint(VIOLET, 0.8)}`,
          transform: `scale(${(1 - 0.05 * press).toFixed(4)})`,
        }}
      >
        <Check color="#ffffff" size={24} />
        {approved ? "Approved" : "Approve all"}
      </div>
    </div>
  );
};

/** Each employee walks its work into the inbox, then stays beside it. */
export const InboxCarriers: React.FC<{
  t: number;
  timing: InboxTiming;
  /** The walk to row `i` (the wide film's unless given). */
  path?: (i: number) => Path;
}> = ({ t, timing, path = yesCarryPath }) => (
  <>
    {YES_ROWS.map((row, i) => {
      const start = yesCarryStart(i, timing);
      if (t < start) return null;
      const s = walkState(path(i), t, start, timing.carryDuration);
      const land = yesLandsAt(i, timing);
      const settle = smoothstep(land, land + 0.35, t);
      const angle = lerpAngle(s.angle, 0, settle);
      const tagGone = smoothstep(land - 0.05, land + 0.22, t);
      const sway = 2.2 * Math.sin(s.phase * Math.PI * 2) * s.amp;
      const tone = TONES[row.who];
      return (
        <div key={row.who}>
          {tagGone < 1 ? (
            <div
              style={{
                position: "absolute",
                left: s.x - 30,
                top: s.y - 72,
                width: 60,
                height: 42,
                borderRadius: 10,
                background: "#ffffff",
                border: "1.5px solid #e2ddf0",
                boxShadow: "0 10px 22px -10px hsl(258 50% 30% / 0.5)",
                opacity: 1 - tagGone,
                transform: `rotate(${sway.toFixed(2)}deg) scale(${(1 - 0.4 * tagGone).toFixed(3)})`,
                transformOrigin: "30px 42px",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 7,
                  top: 9,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  background: tone.color,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    width: 15,
                    height: 10,
                    color: "#ffffff",
                  }}
                >
                  <AntMark />
                </span>
              </span>
              <span
                style={{
                  position: "absolute",
                  left: 34,
                  top: 13,
                  width: 18,
                  height: 5,
                  borderRadius: 3,
                  background: "#d9d5e6",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  left: 34,
                  top: 23,
                  width: 12,
                  height: 5,
                  borderRadius: 3,
                  background: "#e6e2f0",
                }}
              />
            </div>
          ) : null}
          <WorkerAnt
            x={s.x}
            y={s.y}
            angle={angle}
            size={60}
            color={tone.color}
            phase={s.phase}
            amp={s.amp}
          />
        </div>
      );
    })}
  </>
);

/** The owner's pointer: in from the corner, rests on Approve, presses it on "yes". */
export const InboxCursor: React.FC<{ t: number; timing: InboxTiming }> = ({
  t,
  timing,
}) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.click + 1.2, timing.click + 1.6, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={yesCursorKeys(timing)}
      clicks={[timing.click]}
      opacity={opacity}
    />
  );
};
