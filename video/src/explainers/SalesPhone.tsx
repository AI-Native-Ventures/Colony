import { INTER } from "../launch/fonts";
import {
  easeInOutCubic,
  easeOutExpo,
  lerp,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { callClock } from "../launch/wide/call.ts";
import { draftsReady, emailTypedAt } from "../launch/wide/email.ts";
import { TONES } from "../launch/wide/employees.ts";
import { typewriterAt } from "../launch/wide/typewriter.ts";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import { EP04, EP04_CALL, EP04_EMAIL, EP04_NEXT, EP04_REPLY } from "./ep04.ts";
import {
  CALL_PHONE as C,
  DIVIDER_TOP,
  PHONE_BODY,
  phoneBodyLineTop,
  PUSH_AT,
  PUSH_SECONDS,
  RECIPIENT_TOP,
  REPLY_PHONE,
  SHEET,
  SUBJECT_TOP,
} from "./ep04Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import {
  PhonePill,
  PhonePush,
  PhoneTitle,
  PinnedButton,
  tint,
} from "./phoneKit";
import { Tick } from "./RisePostsCard";

const AMBER = TONES.amber;
const INK = "#17151f";
const BODY_INK = "#2b2838";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const W = PHONE_CARD.w - 2 * PHONE_PAD;
const PEN_SIZE = 54;
/** From the pen ant's centre to the tips of its antennae, which write. */
const PEN_REACH = PEN_SIZE * 0.42;
/** The pen ant walks just under the line it writes. */
const PEN_DROP = 60;
const DIP = 18;

type Timing = typeof EP04;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Body text width at the phone's size, measured in Inter (fonts load before any frame renders). */
function bodyWidth(text: string): number {
  if (!measureCtx)
    measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * PHONE_BODY.size * 0.5;
  measureCtx.font = `500 ${PHONE_BODY.size}px "${INTER}"`;
  return measureCtx.measureText(text).width;
}

const lines = [...EP04_EMAIL.lines];

function writer(timing: Timing) {
  return {
    start: timing.typeFrom,
    cps: timing.typeCps,
    returnSeconds: timing.returnSeconds,
  };
}

/** Where the pen ant is, card pixels: walking in, writing under a line, or hopping back for the next. */
function penState(t: number, timing: Timing) {
  const startX = PHONE_PAD - PEN_REACH;
  const lineY = (i: number) => phoneBodyLineTop(i) + PEN_DROP;
  if (t < timing.typeFrom) {
    const k = easeInOutCubic(
      progress(t, timing.walkFrom, timing.typeFrom - timing.walkFrom),
    );
    return {
      x: lerp(startX - 150, startX, k),
      y: lerp(lineY(0) + 40, lineY(0), k),
      angle: 0,
      amp: k > 0 && k < 1 ? 1 : 0,
      phase: (t - timing.walkFrom) * 4,
    };
  }
  const state = typewriterAt(lines, t, writer(timing));
  const i = state.line;
  const endX = PHONE_PAD + bodyWidth(state.typed[i]) - PEN_REACH;
  const phase = (t - timing.typeFrom) * 5;
  if (state.returning > 0) {
    const r = state.returning;
    const e = easeInOutCubic(r);
    return {
      x: lerp(endX, startX, e),
      y: lerp(lineY(i), lineY(i + 1), e) + DIP * Math.sin(Math.PI * r),
      angle: -0.28 * Math.cos(Math.PI * r),
      amp: 0,
      phase,
    };
  }
  return { x: endX, y: lineY(i), angle: 0, amp: state.done ? 0 : 1, phase };
}

/** "Outreach.": the email to the venue writing itself, sent, and the venue's answer. */
function Email({ t, timing }: { t: number; timing: Timing }) {
  const state = typewriterAt(lines, t, writer(timing));
  const typing = t >= timing.typeFrom && !state.done;
  const ready = draftsReady(t, timing, lines);
  const firstAt = emailTypedAt(timing, lines) + 0.1;
  const rushEnd = timing.countRushFrom + timing.countRush;
  const bump = Math.max(
    t >= firstAt ? 1 - progress(t, firstAt, 0.28) : 0,
    t >= rushEnd ? 1 - progress(t, rushEnd, 0.35) : 0,
  );
  const sent = t >= timing.sentAt;
  const reply = easeOutExpo(progress(t, timing.replyAt, 0.5));
  const pen = penState(t, timing);
  const penIn = smoothstep(timing.walkFrom, timing.walkFrom + 0.25, t);
  return (
    <>
      <PhoneTitle text="Outreach." />
      <PhonePill
        label={
          ready === 0
            ? "Writing…"
            : `${ready} ${ready === 1 ? "draft" : "drafts"} ready`
        }
        tone={AMBER}
        opacity={1}
        bump={bump}
      />
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          right: PHONE_PAD,
          top: RECIPIENT_TOP,
          height: 70,
          display: "flex",
          alignItems: "center",
          gap: 18,
        }}
      >
        <span
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            background: AMBER.color,
            color: "#ffffff",
            fontSize: 30,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          {EP04_EMAIL.to[0]}
        </span>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 30, fontWeight: 700, color: INK }}>
            {EP04_EMAIL.to}
          </span>
          <span style={{ fontSize: 24, color: MUTED }}>
            {EP04_EMAIL.company}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            height: 42,
            padding: "0 18px",
            borderRadius: 999,
            background: tint(AMBER.color, 0.14),
            color: AMBER.deep,
            fontSize: 22,
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {sent ? <Tick size={20} color={AMBER.deep} /> : null}
          {sent ? "Sent" : "Draft"}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: DIVIDER_TOP,
          height: 1.5,
          background: LINE,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: SUBJECT_TOP,
          width: W,
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: INK,
          whiteSpace: "nowrap",
        }}
      >
        {EP04_EMAIL.subject}
      </div>
      {state.typed.map((text, i) =>
        text.length > 0 || (typing && i === state.line) ? (
          <div
            key={EP04_EMAIL.lines[i]}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: phoneBodyLineTop(i),
              fontSize: PHONE_BODY.size,
              fontWeight: 500,
              lineHeight: `${PHONE_BODY.lineHeight}px`,
              color: BODY_INK,
              whiteSpace: "nowrap",
            }}
          >
            {text}
          </div>
        ) : null,
      )}
      {t >= timing.walkFrom && t < PUSH_AT + 0.1 ? (
        <div style={{ opacity: penIn }}>
          <WorkerAnt
            x={pen.x}
            y={pen.y}
            angle={pen.angle}
            size={PEN_SIZE}
            color={AMBER.color}
            phase={pen.phase}
            amp={pen.amp}
          />
        </div>
      ) : null}
      {reply > 0 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: REPLY_PHONE.top,
            width: W,
            height: REPLY_PHONE.h,
            borderRadius: 26,
            background: tint(AMBER.color, 0.1),
            border: `2px solid ${tint(AMBER.color, 0.35)}`,
            boxSizing: "border-box",
            padding: "18px 24px",
            opacity: reply,
            transform: `translateY(${((1 - reply) * 24).toFixed(2)}px)`,
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, color: AMBER.deep }}>
            {EP04_REPLY.label}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 30,
              fontWeight: 600,
              lineHeight: 1.3,
              color: INK,
            }}
          >
            {EP04_REPLY.text}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** The call: the venue's avatar, the timer, the voice, what each side says, the booking. */
function Call({ t, timing }: { t: number; timing: Timing }) {
  const connected = t >= timing.connectAt;
  const stop = Math.min(t, timing.bookedAt);
  const ring = connected ? 0 : (t * 1.6) % 1;
  const talking =
    smoothstep(timing.connectAt, timing.connectAt + 0.3, t) *
    (1 - smoothstep(timing.bookedAt - 0.2, timing.bookedAt + 0.2, t));
  const us = easeOutExpo(progress(t, timing.bubble1At, 0.45));
  const them = easeOutExpo(progress(t, timing.bubble2At, 0.45));
  const booked = easeOutExpo(progress(t, timing.bookedAt, 0.5));
  const center: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
  };
  return (
    <>
      {ring > 0 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_CARD.w / 2 - C.avatar / 2,
            top: C.avatarCy - C.avatar / 2,
            width: C.avatar,
            height: C.avatar,
            borderRadius: "50%",
            border: `4px solid ${tint(AMBER.color, 0.5 * (1 - ring))}`,
            boxSizing: "border-box",
            transform: `scale(${(1 + ring * 0.6).toFixed(3)})`,
          }}
        />
      ) : null}
      <span
        style={{
          position: "absolute",
          left: PHONE_CARD.w / 2 - C.avatar / 2,
          top: C.avatarCy - C.avatar / 2,
          width: C.avatar,
          height: C.avatar,
          borderRadius: "50%",
          background: AMBER.color,
          color: "#ffffff",
          fontSize: 60,
          fontWeight: 700,
          display: "grid",
          placeItems: "center",
          boxShadow: `0 24px 50px -24px ${tint(AMBER.color, 0.9)}`,
        }}
      >
        {EP04_CALL.name[0]}
      </span>
      <div
        style={{
          ...center,
          top: C.nameTop,
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: INK,
        }}
      >
        {EP04_CALL.name}
      </div>
      <div style={{ ...center, top: C.companyTop, fontSize: 26, color: MUTED }}>
        {EP04_CALL.company}
      </div>
      <div
        style={{
          ...center,
          top: C.timerTop,
          fontSize: 30,
          fontWeight: 700,
          color: AMBER.deep,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {connected ? callClock(stop, timing) : "Calling…"}
      </div>
      <div
        style={{
          position: "absolute",
          left: (PHONE_CARD.w - 600) / 2,
          top: C.waveTop,
          width: 600,
          height: C.waveH,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        {Array.from({ length: 28 }, (_, k) => {
          const wave =
            0.5 +
            0.5 * Math.sin(t * 9 + k * 0.9) * Math.sin(t * 3.1 + k * 0.37);
          const h = 6 + talking * (C.waveH - 6) * Math.abs(wave);
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed bars
              key={k}
              style={{
                width: 10,
                height: h,
                borderRadius: 5,
                background: tint(AMBER.color, 0.35 + 0.65 * talking),
              }}
            />
          );
        })}
      </div>
      {us > 0 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: C.usTop,
            maxWidth: C.bubbleW,
            padding: "16px 24px",
            borderRadius: "26px 26px 26px 8px",
            background: tint(AMBER.color, 0.14),
            color: INK,
            fontSize: 28,
            fontWeight: 600,
            lineHeight: 1.3,
            opacity: us,
            transform: `translateY(${((1 - us) * 14).toFixed(2)}px)`,
          }}
        >
          {EP04_CALL.lines[0].text}
        </div>
      ) : null}
      {them > 0 ? (
        <div
          style={{
            position: "absolute",
            right: PHONE_PAD,
            top: C.themTop,
            maxWidth: C.bubbleW,
            padding: "16px 24px",
            borderRadius: "26px 26px 8px 26px",
            background: "#f2f1f6",
            color: INK,
            fontSize: 28,
            fontWeight: 600,
            lineHeight: 1.3,
            opacity: them,
            transform: `translateY(${((1 - them) * 14).toFixed(2)}px)`,
          }}
        >
          {EP04_CALL.lines[1].text}
        </div>
      ) : null}
      {booked > 0 ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: C.bookedTop,
            height: C.bookedH,
            display: "flex",
            justifyContent: "center",
            opacity: booked,
            transform: `scale(${(0.85 + 0.15 * booked).toFixed(4)})`,
          }}
        >
          <span
            style={{
              height: C.bookedH,
              padding: "0 30px",
              borderRadius: 999,
              background: AMBER.color,
              color: "#ffffff",
              fontSize: 28,
              fontWeight: 750,
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
              boxShadow: `0 18px 34px -16px ${tint(AMBER.color, 0.9)}`,
            }}
          >
            <Tick size={26} color="#ffffff" />
            {EP04_CALL.booked}
          </span>
        </div>
      ) : null}
    </>
  );
}

/** The sheet that slides up for your yes: the next emails, Approve at its foot. */
function NextSheet({ t, timing }: { t: number; timing: Timing }) {
  const e = easeOutExpo(progress(t, timing.yesCardIn, 0.55));
  if (e <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: SHEET.top,
        bottom: 0,
        borderRadius: "36px 36px 0 0",
        background: "#ffffff",
        boxShadow: "0 -24px 50px -30px rgb(23 21 31 / 0.35)",
        borderTop: `1.5px solid ${LINE}`,
        opacity: e,
        transform: `translateY(${((1 - e) * 240).toFixed(2)}px)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: SHEET.titleTop - SHEET.top,
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          color: INK,
        }}
      >
        {EP04_NEXT.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: SHEET.subTop - SHEET.top,
          fontSize: 26,
          color: MUTED,
        }}
      >
        {EP04_NEXT.subtitle}
      </div>
    </div>
  );
}

/** Episode 4's work on the phone card: the email, the reply, the call, the next emails for your yes. */
export const SalesPhone: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP04,
}) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(30 60% 30% / 0.4)">
    <PhonePush
      t={t}
      at={PUSH_AT}
      seconds={PUSH_SECONDS}
      first={<Email t={t} timing={timing} />}
      second={<Call t={t} timing={timing} />}
    />
    <NextSheet t={t} timing={timing} />
    <PinnedButton
      t={t}
      tone={AMBER}
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
