import { INTER } from "../fonts";
import {
  easeInOutCubic,
  easeOutExpo,
  lerp,
  lerpAngle,
  progress,
  smoothstep,
} from "../math.ts";
import {
  BODY,
  BODY_FONT_SIZE,
  bodyLineTop,
  draftsReady,
  EMAIL,
  EMAIL_CARD,
  type Email,
  emailTypedAt,
} from "./email.ts";
import { TONES } from "./employees.ts";
import { typewriterAt } from "./typewriter.ts";
import { type Path, walkState } from "./walk.ts";
import { WorkerAnt } from "./WorkerAnt";

export type EmailTiming = {
  cardIn: number;
  /** The call card takes over the same spot from here. */
  callIn: number;
  walkFrom: number;
  typeFrom: number;
  typeCps: number;
  returnSeconds: number;
  countRushFrom: number;
  countRush: number;
};

const AMBER = TONES.amber;
const INK = "#17151f";
const BODY_INK = "#2b2838";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const PEN_SIZE = 54;
/** From the pen ant's centre to the tips of its antennae, which write. */
const PEN_REACH = PEN_SIZE * 0.42;
/** The pen ant walks just under the line it writes. */
const PEN_DROP = 60;
/** The carriage return dips under the next line, clear of the words already written. */
const DIP = 18;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width of body text in px, measured with the real font (fonts load before any frame renders). */
function bodyWidth(text: string): number {
  if (!measureCtx)
    measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * BODY_FONT_SIZE * 0.5;
  measureCtx.font = `500 ${BODY_FONT_SIZE}px "${INTER}"`;
  return measureCtx.measureText(text).width;
}

function tint(alpha: number): string {
  return AMBER.color.replace(")", ` / ${alpha})`);
}

function options(timing: EmailTiming) {
  return {
    start: timing.typeFrom,
    cps: timing.typeCps,
    returnSeconds: timing.returnSeconds,
  };
}

/** Where the pen ant is: walking in, writing along a line, or hopping back for the next one. */
function penState(t: number, timing: EmailTiming, lines: readonly string[]) {
  const left = EMAIL_CARD.x + BODY.x;
  const lineY = (i: number) => EMAIL_CARD.y + bodyLineTop(i) + PEN_DROP;
  const startX = left - PEN_REACH;
  if (t < timing.typeFrom) {
    // A short walk in from the gap beside the card, clear of the subtitles.
    const path: Path = [
      { x: startX - 130, y: lineY(0) + 50 },
      { x: startX - 90, y: lineY(0) + 20 },
      { x: startX - 40, y: lineY(0) },
      { x: startX, y: lineY(0) },
    ];
    const s = walkState(
      path,
      t,
      timing.walkFrom,
      timing.typeFrom - timing.walkFrom,
    );
    const settle = smoothstep(timing.typeFrom - 0.3, timing.typeFrom, t);
    return { ...s, angle: lerpAngle(s.angle, 0, settle), writing: false };
  }
  const state = typewriterAt([...lines], t, options(timing));
  const i = state.line;
  const endX = left + bodyWidth(state.typed[i]) - PEN_REACH;
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
      writing: false,
    };
  }
  return {
    x: endX,
    y: lineY(i),
    angle: 0,
    amp: state.done ? 0 : 1,
    phase,
    writing: !state.done,
  };
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "outline" | "amber";
}) {
  return (
    <span
      style={{
        height: 40,
        padding: "0 16px",
        borderRadius: 999,
        fontSize: 21,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        border: tone === "outline" ? `1.5px solid ${LINE}` : "none",
        background: tone === "amber" ? tint(0.14) : "#ffffff",
        color: tone === "amber" ? AMBER.deep : MUTED,
      }}
    >
      {children}
    </span>
  );
}

/** The real Outreach screen as one big flat card: the draft writes itself (Thabo's in the film). */
export const EmailCard: React.FC<{
  t: number;
  timing: EmailTiming;
  email?: Email;
  /** When the draft's badge turns to Sent; never in the film. */
  sentAt?: number;
}> = ({ t, timing, email = EMAIL, sentAt }) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  const handOver = smoothstep(timing.callIn - 0.05, timing.callIn + 0.35, t);
  if (enter <= 0 || handOver >= 1) return null;
  const state = typewriterAt([...email.lines], t, options(timing));
  const typing = t >= timing.typeFrom && !state.done;
  const ready = draftsReady(t, timing, email.lines);
  const firstAt = emailTypedAt(timing, email.lines) + 0.1;
  const rushEnd = timing.countRushFrom + timing.countRush;
  const bump = Math.max(
    t >= firstAt ? 1 - progress(t, firstAt, 0.28) : 0,
    t >= rushEnd ? 1 - progress(t, rushEnd, 0.35) : 0,
  );
  const caretX = bodyWidth(state.typed[state.line]);
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
        opacity: enter * (1 - handOver),
        transform: `translateX(${((1 - enter) * 90).toFixed(2)}px) translateY(${(-30 * handOver).toFixed(2)}px)`,
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
        Review and send emails to your new customers.
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 54,
          height: 64,
          padding: "0 28px",
          borderRadius: 999,
          background: tint(0.14),
          color: AMBER.deep,
          fontSize: 32,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          fontVariantNumeric: "tabular-nums",
          transform: `scale(${(1 + 0.08 * bump).toFixed(4)})`,
        }}
      >
        {ready === 0
          ? "Writing…"
          : `${ready} ${ready === 1 ? "draft" : "drafts"} ready`}
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
          }}
        >
          {email.to[0]}
        </span>
        <span style={{ fontSize: 30, fontWeight: 650 }}>{email.to}</span>
        <span style={{ fontSize: 26, color: MUTED }}>at {email.company}</span>
        <span style={{ flex: 1 }} />
        <Badge tone="outline">Email</Badge>
        <Badge tone="amber">
          {sentAt !== undefined && t >= sentAt ? "Sent" : "Draft"}
        </Badge>
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
          top: 324,
          fontSize: 38,
          fontWeight: 750,
          letterSpacing: "-0.015em",
        }}
      >
        {email.subject}
      </div>
      {state.typed.map((text, i) =>
        text.length === 0 ? null : (
          <div
            key={email.lines[i]}
            style={{
              position: "absolute",
              left: BODY.x,
              top: bodyLineTop(i),
              height: BODY.lineHeight,
              lineHeight: `${BODY.lineHeight}px`,
              fontSize: BODY_FONT_SIZE,
              fontWeight: 500,
              color: BODY_INK,
              whiteSpace: "pre",
            }}
          >
            {text}
          </div>
        ),
      )}
      {typing && state.returning === 0 ? (
        <div
          style={{
            position: "absolute",
            left: BODY.x + caretX + 2,
            top: bodyLineTop(state.line) + 10,
            width: 3,
            height: 34,
            borderRadius: 2,
            background: AMBER.color,
          }}
        />
      ) : null}
    </div>
  );
};

/** The amber ant that writes the email, walking under each line like a pen. */
export const PenAnt: React.FC<{
  t: number;
  timing: EmailTiming;
  email?: Email;
}> = ({ t, timing, email = EMAIL }) => {
  const leave = smoothstep(timing.callIn - 0.1, timing.callIn + 0.25, t);
  if (t < timing.walkFrom || leave >= 1) return null;
  const s = penState(t, timing, email.lines);
  return (
    <WorkerAnt
      x={s.x}
      y={s.y}
      angle={s.angle}
      size={PEN_SIZE}
      color={AMBER.color}
      phase={s.phase}
      amp={s.amp}
      opacity={
        smoothstep(timing.walkFrom, timing.walkFrom + 0.25, t) * (1 - leave)
      }
    />
  );
};
