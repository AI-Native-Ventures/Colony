import { AntMark } from "../brand/AntMark";
import {
  easeInOutCubic,
  easeOutExpo,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { TONES, type Tone } from "../launch/wide/employees.ts";
import { EP07, EP07_DRAFT as D, EP07_QUEUE, queueRowAt } from "./ep07.ts";
import {
  AFTER,
  DRAFT,
  PLANE,
  PUSH_AT,
  PUSH_SECONDS,
  QUEUE,
} from "./ep07Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import { PhonePush, PhoneTitle, PinnedButton, tint } from "./phoneKit";
import { Caret, Rewrite, typedCount } from "./ReviewCard";

const INK = "#17151f";
const BODY = "#2b2838";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const TEXT_W = PHONE_CARD.w - 2 * PHONE_PAD;

type Timing = typeof EP07;

function SmallPill({
  children,
  fill,
  color,
}: {
  children: React.ReactNode;
  fill: string;
  color: string;
}) {
  return (
    <span
      style={{
        height: 40,
        padding: "0 18px",
        borderRadius: 999,
        fontSize: 22,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        background: fill,
        color,
      }}
    >
      {children}
    </span>
  );
}

/** "Waiting for you.": one row per piece of work, the quote reply tapped as it is introduced. */
function Queue({ t, tone, timing }: { t: number; tone: Tone; timing: Timing }) {
  const pick = t >= timing.openAt ? 1 - progress(t, timing.openAt, 0.6) : 0;
  const ripple = progress(t, timing.openAt, 0.5);
  return (
    <>
      <PhoneTitle text="Waiting for you." />
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: 104,
          fontSize: 26,
          color: MUTED,
        }}
      >
        Nothing goes out until you say yes.
      </div>
      {EP07_QUEUE.map((row, i) => {
        const e = easeOutExpo(progress(t, queueRowAt(i, timing), 0.5));
        if (e <= 0) return null;
        const ring = i === 0 ? pick : 0;
        return (
          <div
            key={row.title}
            style={{
              position: "absolute",
              left: 28,
              right: 28,
              top: QUEUE.top + i * QUEUE.step,
              height: QUEUE.h,
              borderRadius: 28,
              overflow: "hidden",
              border: `2px solid ${ring > 0 ? tint(tone.color, 0.7 * ring + 0.2) : LINE}`,
              background: ring > 0 ? tint(tone.color, 0.06) : "#ffffff",
              boxSizing: "border-box",
              opacity: e,
              transform: `translateY(${((1 - e) * 24).toFixed(2)}px)`,
            }}
          >
            {i === 0 && ripple > 0 && ripple < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: 372 - 420 * ripple,
                  top: QUEUE.h / 2 - 420 * ripple,
                  width: 840 * ripple,
                  height: 840 * ripple,
                  borderRadius: "50%",
                  background: tint(tone.color, 0.16 * (1 - ripple)),
                }}
              />
            ) : null}
            <span
              style={{
                position: "absolute",
                left: 22,
                top: 28,
                width: 88,
                height: 88,
                borderRadius: 44,
                background: TONES[row.who].color,
                display: "grid",
                placeItems: "center",
              }}
            >
              <span
                style={{
                  display: "flex",
                  width: 54,
                  height: 36,
                  color: "#fff",
                }}
              >
                <AntMark />
              </span>
            </span>
            <div
              style={{
                position: "absolute",
                left: 132,
                top: 26,
                fontSize: 34,
                fontWeight: 750,
                letterSpacing: "-0.02em",
                color: INK,
                whiteSpace: "nowrap",
              }}
            >
              {row.title}
            </div>
            <div
              style={{
                position: "absolute",
                left: 132,
                top: 80,
                display: "flex",
                alignItems: "center",
                gap: 14,
                fontSize: 26,
                color: MUTED,
              }}
            >
              {row.kind}
              <SmallPill fill={tint(tone.color, 0.12)} color={tone.deep}>
                Waiting
              </SmallPill>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The quote reply: the first draft, your note, then the rewrite under the draft made small. */
function Draft({ t, tone, timing }: { t: number; tone: Tone; timing: Timing }) {
  const split = easeInOutCubic(progress(t, timing.rewriteAt, 0.5));
  const note = easeOutExpo(progress(t, timing.noteIn, 0.5));
  const noteN = typedCount(t, timing.noteFrom, timing.noteCps, D.note.length);
  const afterN = typedCount(
    t,
    timing.rewriteAt + 0.3,
    timing.rewriteCps,
    D.after.length,
  );
  const sent = t >= timing.sentAt;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: DRAFT.headerH,
          borderBottom: `1.5px solid ${LINE}`,
          boxSizing: "border-box",
        }}
      >
        <svg
          aria-hidden="true"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          style={{ position: "absolute", left: 24, top: 44 }}
        >
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke={tone.color}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span
          style={{
            position: "absolute",
            left: 70,
            top: 30,
            width: 64,
            height: 64,
            borderRadius: 32,
            background: TONES.amber.color,
            color: "#ffffff",
            fontSize: 30,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
          }}
        >
          {D.to[0]}
        </span>
        <div
          style={{
            position: "absolute",
            left: 152,
            top: 26,
            fontSize: 34,
            fontWeight: 750,
            color: INK,
          }}
        >
          {D.to}
        </div>
        <div
          style={{
            position: "absolute",
            left: 152,
            top: 70,
            fontSize: 24,
            color: MUTED,
          }}
        >
          {D.context}
        </div>
        <div style={{ position: "absolute", right: 36, top: 42 }}>
          <SmallPill fill={tint(tone.color, 0.14)} color={tone.deep}>
            {sent ? "Sent" : "Draft"}
          </SmallPill>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: DRAFT.subjectTop,
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: INK,
        }}
      >
        {D.subject}
      </div>
      {split < 1 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: DRAFT.bodyTop,
            width: TEXT_W,
            fontSize: 28,
            fontWeight: 500,
            lineHeight: 1.45,
            color: BODY,
            opacity: 1 - split,
          }}
        >
          {D.before}
        </div>
      ) : null}
      {split > 0 ? (
        <div
          style={{
            opacity: split,
            transform: `translateY(${((1 - split) * 12).toFixed(2)}px)`,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: AFTER.beforeTop,
              width: TEXT_W,
            }}
          >
            <SmallPill fill="#f2f1f6" color={MUTED}>
              Before
            </SmallPill>
            <div
              style={{
                marginTop: 10,
                fontSize: 22,
                lineHeight: 1.4,
                color: "#8a879a",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {D.before}
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: AFTER.afterTop,
              width: TEXT_W,
            }}
          >
            <SmallPill fill={tint(tone.color, 0.14)} color={tone.deep}>
              After
            </SmallPill>
            <div
              style={{
                marginTop: 12,
                fontSize: 30,
                fontWeight: 500,
                lineHeight: 1.45,
                color: BODY,
              }}
            >
              <Rewrite n={afterN} tone={tone} />
            </div>
          </div>
        </div>
      ) : null}
      {note > 0 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: DRAFT.noteTop,
            width: TEXT_W,
            height: DRAFT.noteH,
            borderRadius: 24,
            background: "#f7f6fb",
            border: `2px solid ${noteN > 0 ? tint(tone.color, 0.45) : LINE}`,
            boxSizing: "border-box",
            padding: "14px 24px",
            opacity: note,
            transform: `translateY(${((1 - note) * 14).toFixed(2)}px)`,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, color: MUTED }}>
            Your note
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 28,
              fontWeight: 600,
              lineHeight: 1.3,
              color: INK,
            }}
          >
            {D.note.slice(0, noteN)}
            {noteN < D.note.length && t < timing.rewriteAt ? (
              <Caret color={tone.color} />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Episode 7's work on the phone card: the queue, the quote reply, your note, the rewrite, your yes. */
export const ReviewPhone: React.FC<{
  t: number;
  tone: Tone;
  timing?: Timing;
}> = ({ t, tone, timing = EP07 }) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(258 60% 40% / 0.45)">
    <PhonePush
      t={t}
      at={PUSH_AT}
      seconds={PUSH_SECONDS}
      first={<Queue t={t} tone={tone} timing={timing} />}
      second={<Draft t={t} tone={tone} timing={timing} />}
    />
    <PinnedButton
      t={t}
      tone={tone}
      idle="Approve"
      done="Approved"
      timing={{
        approveIn: timing.approveIn,
        click: timing.click,
        doneAt: timing.approvedAt,
      }}
    />
  </PhoneCard>
);

/** The approved email leaving: a paper plane from the pinned button, up and off the frame. Frame pixels. */
export const PhonePlane: React.FC<{ t: number; at: number; color: string }> = ({
  t,
  at,
  color,
}) => {
  const k = progress(t, at, 0.9);
  if (k <= 0 || k >= 1) return null;
  const e = k * k;
  const x = PLANE.from.x + (PLANE.to.x - PLANE.from.x) * e;
  const y =
    PLANE.from.y +
    (PLANE.to.y - PLANE.from.y) * e -
    160 * Math.sin(Math.PI * k);
  return (
    <svg
      aria-hidden="true"
      width="80"
      height="80"
      viewBox="0 0 24 24"
      style={{
        position: "absolute",
        left: x - 40,
        top: y - 40,
        opacity: 1 - smoothstep(0.75, 1, k),
        transform: `rotate(${(-28 + 12 * k).toFixed(2)}deg) scale(${(0.8 + 0.4 * Math.min(1, k * 3)).toFixed(3)})`,
        filter: `drop-shadow(0 8px 14px ${tint(color, 0.45)})`,
      }}
    >
      <path d="M2.5 11.2 21 3.2l-6.4 17.6-3.4-6.9-8.7-2.7Z" fill={color} />
      <path d="M11.2 13.9 21 3.2" stroke="#ffffff" strokeWidth="1.4" />
    </svg>
  );
};
