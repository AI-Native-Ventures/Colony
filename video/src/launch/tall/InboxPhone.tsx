import { PhoneCard } from "../../explainers/PhoneCard";
import { PHONE_PAD } from "../../explainers/phone.ts";
import { PhoneTitle, tint } from "../../explainers/phoneKit";
import { AntMark } from "../../brand/AntMark";
import { Cursor } from "../app/Cursor";
import { easeOutExpo, lerpAngle, progress, smoothstep } from "../math.ts";
import { OWNER, TONES } from "../wide/employees.ts";
import type { InboxTiming } from "../wide/InboxCard";
import { walkState } from "../wide/walk.ts";
import { WorkerAnt } from "../wide/WorkerAnt";
import {
  approvedAt,
  outcomeAt,
  YES_ROWS,
  yesCarryStart,
  yesLandsAt,
} from "../wide/yes.ts";
import {
  INBOX_BUTTONS as BTN,
  INBOX_ROWS as R,
  inboxCarryPath,
  inboxCursorKeys,
  inboxRowTop,
} from "./filmPages.ts";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = OWNER.color;

function Check({ color, size = 20 }: { color: string; size?: number }) {
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

/** Under the title: how many cards wait for the owner, then that nothing does. */
function Waiting({ t, timing }: { t: number; timing: InboxTiming }) {
  const last = approvedAt(YES_ROWS.length - 1, timing);
  const cleared = smoothstep(last + 0.15, last + 0.5, t);
  const waiting = YES_ROWS.filter(
    (_, i) => t >= yesLandsAt(i, timing) && t < approvedAt(i, timing),
  ).length;
  const first = yesLandsAt(0, timing);
  const counting = smoothstep(first - 0.1, first + 0.2, t);
  return (
    <div
      style={{
        position: "absolute",
        left: PHONE_PAD,
        top: 108,
        height: 34,
        fontSize: 26,
        display: "flex",
        alignItems: "center",
        gap: 12,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 6,
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
          color: MUTED,
          opacity: cleared,
        }}
      >
        Nothing is waiting for you. Your team is on it.
      </span>
    </div>
  );
}

/** One piece of work: what it is, where it lives, and its status, Waiting to Approved to what happened. */
function InboxRow({
  t,
  i,
  timing,
}: {
  t: number;
  i: number;
  timing: InboxTiming;
}) {
  const row = YES_ROWS[i];
  const tone = TONES[row.who];
  const arrived = easeOutExpo(progress(t, yesLandsAt(i, timing), 0.45));
  const ok = approvedAt(i, timing);
  const flash = t >= ok ? 1 - progress(t, ok, 0.7) : 0;
  const approved = t >= ok;
  const text = R.textLeft - 20;
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        top: inboxRowTop(i),
        height: R.h,
        borderRadius: 24,
        background: flash > 0 ? tint(tone.color, 0.12 * flash) : undefined,
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
              left: text,
              top: 34,
              width: 380,
              height: 22,
              borderRadius: 11,
              background: "#f3f1f8",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: text,
              top: 78,
              width: 150,
              height: 16,
              borderRadius: 8,
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
              left: text,
              top: 22,
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              color: INK,
              whiteSpace: "nowrap",
            }}
          >
            {row.title}
          </div>
          <div
            style={{
              position: "absolute",
              left: text,
              top: 74,
              height: 40,
              fontSize: 24,
              color: MUTED,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                background: tone.color,
              }}
            />
            {row.kind}
          </div>
          <div
            style={{
              position: "absolute",
              right: 18,
              top: 70,
              height: 46,
              padding: "0 20px",
              borderRadius: 999,
              background: approved
                ? tint(tone.color, 0.14)
                : tint(VIOLET, 0.12),
              color: approved ? tone.deep : OWNER.deep,
              fontSize: 22,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              gap: 8,
              transform: `scale(${(1 + 0.1 * flash).toFixed(4)})`,
              transformOrigin: "right center",
            }}
          >
            {approved ? <Check color={tone.deep} /> : null}
            {t >= outcomeAt(i, timing)
              ? row.outcome
              : approved
                ? "Approved"
                : "Waiting"}
          </div>
        </div>
      )}
    </div>
  );
}

/** Each employee walks its work into the inbox on a tag, then stays at its row's left. Card pixels. */
function Carriers({ t, timing }: { t: number; timing: InboxTiming }) {
  return (
    <>
      {YES_ROWS.map((row, i) => {
        const start = yesCarryStart(i, timing);
        if (t < start) return null;
        const s = walkState(inboxCarryPath(i), t, start, timing.carryDuration);
        const land = yesLandsAt(i, timing);
        const settle = smoothstep(land, land + 0.35, t);
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
              angle={lerpAngle(s.angle, 0, settle)}
              size={56}
              color={tone.color}
              phase={s.phase}
              amp={s.amp}
            />
          </div>
        );
      })}
    </>
  );
}

/** "Send it back" and "Approve all" at the card's foot; Approve all is pressed on the yes. Card pixels. */
function Buttons({ t, timing }: { t: number; timing: InboxTiming }) {
  const press = t >= timing.click && t < timing.click + 0.14 ? 1 : 0;
  const approved = t >= timing.click;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: BTN.sendBack.left,
          top: BTN.top,
          width: BTN.sendBack.w,
          height: BTN.h,
          borderRadius: 999,
          border: `1.5px solid ${LINE}`,
          boxSizing: "border-box",
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
          left: BTN.approve.left,
          top: BTN.top,
          width: BTN.approve.w,
          height: BTN.h,
          borderRadius: 999,
          background: VIOLET,
          color: "#ffffff",
          fontSize: 28,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          boxShadow: `0 18px 36px -16px ${tint(VIOLET, 0.8)}`,
          transform: `scale(${(1 - 0.05 * press).toFixed(4)})`,
        }}
      >
        <Check color="#ffffff" size={26} />
        {approved ? "Approved" : "Approve all"}
      </div>
    </>
  );
}

/** The owner's inbox on the film's phone card: the four pieces of work walked in, one tap approves them all, then what happened to each. */
export const InboxPhone: React.FC<{ t: number; timing: InboxTiming }> = ({
  t,
  timing,
}) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(258 60% 40% / 0.4)">
    <PhoneTitle text="Inbox." />
    <Waiting t={t} timing={timing} />
    {YES_ROWS.map((row, i) => (
      <InboxRow key={row.who} t={t} i={i} timing={timing} />
    ))}
    <Carriers t={t} timing={timing} />
    <Buttons t={t} timing={timing} />
  </PhoneCard>
);

/** The owner's pointer: in from the lower right, at rest on Approve all, pressing it on "yes". Frame pixels. */
export const InboxPhoneCursor: React.FC<{ t: number; timing: InboxTiming }> = ({
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
      keys={inboxCursorKeys(timing)}
      clicks={[timing.click]}
      opacity={opacity}
    />
  );
};
