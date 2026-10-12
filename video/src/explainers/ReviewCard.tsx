import { AntMark } from "../brand/AntMark";
import { INTER } from "../launch/fonts";
import {
  easeInOutCubic,
  easeOutExpo,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { TONES, type Tone } from "../launch/wide/employees.ts";
import {
  type EP07,
  EP07_DRAFT as D,
  EP07_QUEUE,
  NOTE_BOX,
  queueRowAt,
  REVIEW_APPROVE,
  REVIEW_CARD as CARD,
} from "./ep07.ts";

const INK = "#17151f";
const BODY = "#2b2838";
const MUTED = "#6a6780";
const LINE = "#ece9f4";

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

export function typedCount(
  t: number,
  from: number,
  cps: number,
  length: number,
) {
  return Math.max(0, Math.min(length, Math.floor((t - from) * cps)));
}

export function Caret({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 3,
        height: 30,
        marginLeft: 2,
        verticalAlign: "-5px",
        background: color,
      }}
    />
  );
}

function Pill({
  children,
  fill,
  color,
  outline,
}: {
  children: React.ReactNode;
  fill?: string;
  color: string;
  outline?: boolean;
}) {
  return (
    <span
      style={{
        height: 38,
        padding: "0 16px",
        borderRadius: 999,
        fontSize: 20,
        fontWeight: 650,
        display: "inline-flex",
        alignItems: "center",
        border: outline ? `1.5px solid ${LINE}` : "none",
        background: fill ?? "#ffffff",
        color,
      }}
    >
      {children}
    </span>
  );
}

/** The rewrite typed in seconds, with the part the owner asked for marked once it is there. */
export function Rewrite({ n, tone }: { n: number; tone: Tone }) {
  const at = D.after.indexOf(D.added);
  const pre = D.after.slice(0, at);
  const post = D.after.slice(at + D.added.length);
  const added = D.added.slice(0, Math.max(0, n - pre.length));
  return (
    <>
      {pre.slice(0, n)}
      {added ? (
        <span
          style={{
            background: tint(tone.color, 0.18),
            color: tone.deep,
            borderRadius: 6,
            padding: "0 3px",
          }}
        >
          {added}
        </span>
      ) : null}
      {post.slice(0, Math.max(0, n - pre.length - D.added.length))}
      {n < D.after.length ? <Caret color={tone.color} /> : null}
    </>
  );
}

/**
 * The owner's review card: first the queue of work waiting for a yes, then
 * the quote reply opened, the owner's note, and the rewrite beside the
 * first draft.
 */
export const ReviewCard: React.FC<{
  t: number;
  tone: Tone;
  timing: typeof EP07;
}> = ({ t, tone, timing }) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const toDraft = smoothstep(timing.openAt + 0.25, timing.openAt + 0.55, t);
  const pick = t >= timing.openAt ? 1 - progress(t, timing.openAt, 0.6) : 0;
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
    <div
      style={{
        position: "absolute",
        left: CARD.x,
        top: CARD.y,
        width: CARD.w,
        height: CARD.h,
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
        overflow: "hidden",
      }}
    >
      {toDraft < 1 ? (
        <div style={{ position: "absolute", inset: 0, opacity: 1 - toDraft }}>
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
            Waiting for you.
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
            Nothing goes out until you say yes.
          </div>
          <div
            style={{
              position: "absolute",
              right: 48,
              top: 54,
              height: 64,
              padding: "0 28px",
              borderRadius: 999,
              background: tint(tone.color, 0.12),
              color: tone.deep,
              fontSize: 30,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              opacity: smoothstep(
                queueRowAt(0, timing),
                queueRowAt(0, timing) + 0.3,
                t,
              ),
            }}
          >
            {EP07_QUEUE.length} waiting
          </div>
          {EP07_QUEUE.map((row, i) => {
            const e = easeOutExpo(progress(t, queueRowAt(i, timing), 0.5));
            if (e <= 0) return null;
            const rowTone = TONES[row.who];
            const ring = i === 0 ? pick : 0;
            return (
              <div
                key={row.title}
                style={{
                  position: "absolute",
                  left: 36,
                  right: 36,
                  top: 196 + i * 124,
                  height: 108,
                  borderRadius: 24,
                  border: `2px solid ${ring > 0 ? tint(tone.color, 0.7 * ring + 0.2) : LINE}`,
                  background: ring > 0 ? tint(tone.color, 0.06) : "#ffffff",
                  opacity: e,
                  transform: `translateY(${((1 - e) * 24).toFixed(2)}px)`,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 18,
                    top: 14,
                    width: 80,
                    height: 80,
                    borderRadius: 40,
                    background: rowTone.color,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      width: 50,
                      height: 33,
                      color: "#ffffff",
                    }}
                  >
                    <AntMark />
                  </span>
                </span>
                <div
                  style={{
                    position: "absolute",
                    left: 122,
                    top: 14,
                    fontSize: 34,
                    fontWeight: 750,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {row.title}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 122,
                    top: 62,
                    fontSize: 24,
                    color: MUTED,
                  }}
                >
                  {row.kind}
                </div>
                <div
                  style={{
                    position: "absolute",
                    right: 22,
                    top: 30,
                    height: 46,
                    padding: "0 20px",
                    borderRadius: 999,
                    background: tint(tone.color, 0.12),
                    color: tone.deep,
                    fontSize: 23,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  Waiting
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {toDraft > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: toDraft }}>
          <div
            style={{
              position: "absolute",
              left: 52,
              right: 48,
              top: 40,
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
                background: TONES.amber.color,
                color: "#ffffff",
                fontSize: 28,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
              }}
            >
              {D.to[0]}
            </span>
            <span style={{ fontSize: 30, fontWeight: 650 }}>{D.to}</span>
            <span style={{ fontSize: 26, color: MUTED }}>{D.context}</span>
            <span style={{ flex: 1 }} />
            <Pill outline color={MUTED}>
              Email
            </Pill>
            <Pill fill={tint(tone.color, 0.14)} color={tone.deep}>
              {sent ? "Sent" : "Draft"}
            </Pill>
          </div>
          <div
            style={{
              position: "absolute",
              left: 40,
              right: 40,
              top: 124,
              height: 1.5,
              background: LINE,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 52,
              top: 146,
              fontSize: 36,
              fontWeight: 750,
              letterSpacing: "-0.015em",
            }}
          >
            {D.subject}
          </div>
          {split < 1 ? (
            <div
              style={{
                position: "absolute",
                left: 52,
                right: 52,
                top: 214,
                fontSize: 26,
                fontWeight: 500,
                lineHeight: 1.5,
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
                position: "absolute",
                left: 52,
                right: 52,
                top: 210,
                height: 330,
                display: "flex",
                gap: 28,
                opacity: split,
                transform: `translateY(${((1 - split) * 12).toFixed(2)}px)`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Pill fill="#f2f1f6" color={MUTED}>
                  Before
                </Pill>
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 20,
                    lineHeight: 1.45,
                    color: "#8a879a",
                  }}
                >
                  {D.before}
                </div>
              </div>
              <div
                style={{
                  width: 1.5,
                  background: LINE,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Pill fill={tint(tone.color, 0.14)} color={tone.deep}>
                  After
                </Pill>
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 26,
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
                left: NOTE_BOX.x - CARD.x,
                top: NOTE_BOX.y - CARD.y,
                width: NOTE_BOX.w,
                height: NOTE_BOX.h,
                borderRadius: 20,
                background: "#f7f6fb",
                border: `1.5px solid ${noteN > 0 ? tint(tone.color, 0.45) : LINE}`,
                boxSizing: "border-box",
                padding: "10px 22px",
                opacity: note,
                transform: `translateY(${((1 - note) * 14).toFixed(2)}px)`,
              }}
            >
              <div style={{ fontSize: 19, fontWeight: 650, color: MUTED }}>
                Your note
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 26,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {D.note.slice(0, noteN)}
                {noteN < D.note.length && t < timing.rewriteAt ? (
                  <Caret color={tone.color} />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** The approved email leaving: a paper plane from the button, up and out of the frame. */
export const SentPlane: React.FC<{ t: number; at: number; color: string }> = ({
  t,
  at,
  color,
}) => {
  const k = progress(t, at, 0.9);
  if (k <= 0 || k >= 1) return null;
  const e = k * k;
  const from = {
    x: REVIEW_APPROVE.x + REVIEW_APPROVE.w / 2,
    y: REVIEW_APPROVE.y + REVIEW_APPROVE.h / 2,
  };
  const x = from.x + (1960 - from.x) * e;
  const y = from.y + (60 - from.y) * e - 120 * Math.sin(Math.PI * k);
  return (
    <svg
      aria-hidden="true"
      width="64"
      height="64"
      viewBox="0 0 24 24"
      style={{
        position: "absolute",
        left: x - 32,
        top: y - 32,
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
