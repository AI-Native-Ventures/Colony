import { INTER } from "../launch/fonts";
import {
  easeInOutCubic,
  easeOutExpo,
  lerp,
  progress,
  smoothstep,
} from "../launch/math.ts";
import {
  type Call as CallData,
  type CallTiming,
  callClock,
} from "../launch/wide/call.ts";
import {
  type DraftCountTiming,
  draftsReady,
  type Email as EmailData,
  emailTypedAt,
} from "../launch/wide/email.ts";
import { TONES } from "../launch/wide/employees.ts";
import { typewriterAt } from "../launch/wide/typewriter.ts";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import { EP04, EP04_CALL, EP04_EMAIL, EP04_NEXT, EP04_REPLY } from "./ep04.ts";
import {
  CALL_PHONE as C,
  CALL_STACK_GAP,
  DIVIDER_TOP,
  PHONE_BODY,
  phoneBodyLineTop,
  phoneBodyTop,
  PUSH_SECONDS,
  RECIPIENT_TOP,
  REPLY_PHONE,
  SHEET,
  SUBJECT_LINE,
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

/** The episode's timing; the film's sales beat has the email and the call only (no reply, sheet or yes). */
type Timing = DraftCountTiming &
  CallTiming & {
    cardIn: number;
    walkFrom: number;
    sentAt?: number;
    replyAt?: number;
    yesCardIn?: number;
    approveIn?: number;
    click?: number;
    approvedAt?: number;
  };

/** What the sales employee writes and says: the email (its subject in lines when one line is too long), the call, and episode 4's reply and next emails. */
export type SalesSetup = {
  email: EmailData;
  subjectLines?: readonly string[];
  call: CallData;
  /** Stack the call's bubbles and the booking by their height, for lines too long for the fixed slots. */
  stackCall?: boolean;
  reply?: { label: string; text: string };
  next?: { title: string; subtitle: string };
};

const EP04_SETUP: SalesSetup = {
  email: EP04_EMAIL,
  call: EP04_CALL,
  reply: EP04_REPLY,
  next: EP04_NEXT,
};

let measureCtx: CanvasRenderingContext2D | null = null;

/** Body text width at the phone's size, measured in Inter (fonts load before any frame renders). */
function bodyWidth(text: string): number {
  if (!measureCtx)
    measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * PHONE_BODY.size * 0.5;
  measureCtx.font = `500 ${PHONE_BODY.size}px "${INTER}"`;
  return measureCtx.measureText(text).width;
}

function writer(timing: Timing) {
  return {
    start: timing.typeFrom,
    cps: timing.typeCps,
    returnSeconds: timing.returnSeconds,
  };
}

/** Where the pen ant is, card pixels: walking in, writing under a line, or hopping back for the next. */
function penState(t: number, timing: Timing, lines: string[], bodyTop: number) {
  const startX = PHONE_PAD - PEN_REACH;
  const lineY = (i: number) => phoneBodyLineTop(i, bodyTop) + PEN_DROP;
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

/** "Outreach.": the email writing itself, sent, and the answer (episode 4). */
function Email({
  t,
  timing,
  setup,
}: {
  t: number;
  timing: Timing;
  setup: SalesSetup;
}) {
  const { email } = setup;
  const lines = [...email.lines];
  const bodyTop = phoneBodyTop(setup.subjectLines?.length ?? 1);
  const state = typewriterAt(lines, t, writer(timing));
  const typing = t >= timing.typeFrom && !state.done;
  const ready = draftsReady(t, timing, lines);
  const firstAt = emailTypedAt(timing, lines) + 0.1;
  const rushEnd = timing.countRushFrom + timing.countRush;
  const bump = Math.max(
    t >= firstAt ? 1 - progress(t, firstAt, 0.28) : 0,
    t >= rushEnd ? 1 - progress(t, rushEnd, 0.35) : 0,
  );
  const sent = timing.sentAt !== undefined && t >= timing.sentAt;
  const reply =
    setup.reply && timing.replyAt !== undefined
      ? easeOutExpo(progress(t, timing.replyAt, 0.5))
      : 0;
  const pen = penState(t, timing, lines, bodyTop);
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
          {email.to[0]}
        </span>
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 30, fontWeight: 700, color: INK }}>
            {email.to}
          </span>
          <span style={{ fontSize: 24, color: MUTED }}>{email.company}</span>
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
      {setup.subjectLines ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: SUBJECT_TOP,
            width: W,
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            lineHeight: `${SUBJECT_LINE}px`,
            color: INK,
          }}
        >
          {setup.subjectLines.map((line) => (
            <div key={line} style={{ whiteSpace: "nowrap" }}>
              {line}
            </div>
          ))}
        </div>
      ) : (
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
          {email.subject}
        </div>
      )}
      {state.typed.map((text, i) =>
        text.length > 0 || (typing && i === state.line) ? (
          <div
            key={lines[i]}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: phoneBodyLineTop(i, bodyTop),
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
      {t >= timing.walkFrom && t < timing.callIn + 0.1 ? (
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
      {setup.reply && reply > 0 ? (
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
            {setup.reply.label}
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
            {setup.reply.text}
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One side's speech bubble on the call, without its place. */
function bubble(who: "us" | "them", e: number): React.CSSProperties {
  return {
    maxWidth: C.bubbleW,
    padding: "16px 24px",
    borderRadius: who === "us" ? "26px 26px 26px 8px" : "26px 26px 8px 26px",
    background: who === "us" ? tint(AMBER.color, 0.14) : "#f2f1f6",
    color: INK,
    fontSize: 28,
    fontWeight: 600,
    lineHeight: 1.3,
    opacity: e,
    transform: `translateY(${((1 - e) * 14).toFixed(2)}px)`,
  };
}

/** "Meeting booked", the pill inside its row. */
function BookedPill({ text }: { text: string }) {
  return (
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
      {text}
    </span>
  );
}

/** The call: the other side's avatar, the timer, the voice, what each side says, the booking. */
function Call({
  t,
  timing,
  call,
  stack,
}: {
  t: number;
  timing: Timing;
  call: CallData;
  stack: boolean;
}) {
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
        {call.name[0]}
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
        {call.name}
      </div>
      <div style={{ ...center, top: C.companyTop, fontSize: 26, color: MUTED }}>
        {call.company}
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
      {stack ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            right: PHONE_PAD,
            top: C.usTop,
            display: "flex",
            flexDirection: "column",
            gap: CALL_STACK_GAP,
          }}
        >
          <div style={{ alignSelf: "flex-start", ...bubble("us", us) }}>
            {call.lines[0].text}
          </div>
          <div style={{ alignSelf: "flex-end", ...bubble("them", them) }}>
            {call.lines[1].text}
          </div>
          <div
            style={{
              height: C.bookedH,
              display: "flex",
              justifyContent: "center",
              opacity: booked,
              transform: `scale(${(0.85 + 0.15 * booked).toFixed(4)})`,
            }}
          >
            <BookedPill text={call.booked} />
          </div>
        </div>
      ) : (
        <>
          {us > 0 ? (
            <div
              style={{
                position: "absolute",
                left: PHONE_PAD,
                top: C.usTop,
                ...bubble("us", us),
              }}
            >
              {call.lines[0].text}
            </div>
          ) : null}
          {them > 0 ? (
            <div
              style={{
                position: "absolute",
                right: PHONE_PAD,
                top: C.themTop,
                ...bubble("them", them),
              }}
            >
              {call.lines[1].text}
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
              <BookedPill text={call.booked} />
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/** The sheet that slides up for your yes: the next emails, Approve at its foot. */
function NextSheet({
  t,
  at,
  next,
}: {
  t: number;
  at: number;
  next: { title: string; subtitle: string };
}) {
  const e = easeOutExpo(progress(t, at, 0.55));
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
        {next.title}
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
        {next.subtitle}
      </div>
    </div>
  );
}

/** Episode 4's work on the phone card: the email, the reply, the call, the next emails for your yes; the film's has the email and the call. */
export const SalesPhone: React.FC<{
  t: number;
  timing?: Timing;
  setup?: SalesSetup;
}> = ({ t, timing = EP04, setup = EP04_SETUP }) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(30 60% 30% / 0.4)">
    <PhonePush
      t={t}
      at={timing.callIn}
      seconds={PUSH_SECONDS}
      first={<Email t={t} timing={timing} setup={setup} />}
      second={
        <Call
          t={t}
          timing={timing}
          call={setup.call}
          stack={setup.stackCall ?? false}
        />
      }
    />
    {setup.next && timing.yesCardIn !== undefined ? (
      <NextSheet t={t} at={timing.yesCardIn} next={setup.next} />
    ) : null}
    {timing.approveIn !== undefined &&
    timing.click !== undefined &&
    timing.approvedAt !== undefined ? (
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
    ) : null}
  </PhoneCard>
);
