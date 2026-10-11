import { AntMark } from "../../brand/AntMark";
import { Cursor } from "../app/Cursor";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { GETTING_STARTED, TONES } from "./employees.ts";
import {
  BUSINESS_CARD,
  CONTINUE_BUTTON,
  type HowTiming,
  howCursorKeys,
  READ_BUTTON,
  SUMMARY_TEXT,
  TEAM_ROWS,
  teamRowAt,
  teamRowY,
  WEBSITE,
  WEBSITE_FIELD,
} from "./how.ts";
import { typewriterAt } from "./typewriter.ts";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const FIELD_BG = "#faf9fd";
const VIOLET = GETTING_STARTED.color;

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

function local(r: { x: number; y: number; w: number; h: number }) {
  return {
    left: r.x - BUSINESS_CARD.x,
    top: r.y - BUSINESS_CARD.y,
    width: r.w,
    height: r.h,
  };
}

const label: React.CSSProperties = {
  position: "absolute",
  left: 52,
  fontSize: 22,
  fontWeight: 600,
  color: MUTED,
};

const field: React.CSSProperties = {
  position: "absolute",
  left: 52,
  right: 52,
  height: 76,
  borderRadius: 16,
  border: `1.5px solid ${LINE}`,
  background: FIELD_BG,
  display: "flex",
  alignItems: "center",
  padding: "0 24px",
  fontSize: 30,
  fontWeight: 500,
  color: INK,
  whiteSpace: "nowrap",
  overflow: "hidden",
};

/** The real "Your business" screen: paste the website, Colony reads it, then the team it hired. */
export const BusinessCard: React.FC<{ t: number; timing: HowTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const toTeam = smoothstep(
    timing.continueClick + 0.1,
    timing.continueClick + 0.4,
    t,
  );
  const pasted = t >= timing.pasteAt;
  const flash = pasted ? 1 - progress(t, timing.pasteAt, 0.6) : 0;
  const reading =
    t >= timing.readClick && t < timing.readClick + timing.readFor;
  const readDone = t >= timing.readClick + timing.readFor;
  const scan = progress(t, timing.readClick, timing.readFor);
  const summary = typewriterAt([SUMMARY_TEXT], t, {
    start: timing.readClick + timing.readFor,
    cps: timing.summaryCps,
    returnSeconds: 0,
  }).typed[0];
  const pressRead = t >= timing.readClick && t < timing.readClick + 0.14;
  const pressContinue =
    t >= timing.continueClick && t < timing.continueClick + 0.14;
  return (
    <div
      style={{
        position: "absolute",
        left: BUSINESS_CARD.x,
        top: BUSINESS_CARD.y,
        width: BUSINESS_CARD.w,
        height: BUSINESS_CARD.h,
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
      {toTeam < 1 ? (
        <div style={{ position: "absolute", inset: 0, opacity: 1 - toTeam }}>
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
            Your business.
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
            Only the essentials. You can add more as you go.
          </div>
          <div style={{ ...label, top: 192 }}>Business name</div>
          <div style={{ ...field, top: 226 }}>Bright Plumbing</div>
          <div
            style={{ ...label, top: WEBSITE_FIELD.y - BUSINESS_CARD.y - 36 }}
          >
            Website
          </div>
          <div
            style={{
              ...field,
              ...local(WEBSITE_FIELD),
              right: undefined,
              borderColor: pasted && !readDone ? tint(VIOLET, 0.6) : LINE,
              color: pasted ? INK : "#b4b1c4",
            }}
          >
            <span
              style={{
                background: flash > 0 ? tint(VIOLET, 0.25 * flash) : undefined,
                borderRadius: 6,
              }}
            >
              {pasted ? WEBSITE : "yourbusiness.com"}
            </span>
          </div>
          {reading ? (
            <div
              style={{
                position: "absolute",
                left: WEBSITE_FIELD.x - BUSINESS_CARD.x,
                top: WEBSITE_FIELD.y - BUSINESS_CARD.y + WEBSITE_FIELD.h + 10,
                width: WEBSITE_FIELD.w * scan,
                height: 4,
                borderRadius: 2,
                background: VIOLET,
              }}
            />
          ) : null}
          <div
            style={{
              position: "absolute",
              ...local(READ_BUTTON),
              borderRadius: 999,
              border: `1.5px solid ${reading ? tint(VIOLET, 0.5) : LINE}`,
              background: reading ? tint(VIOLET, 0.08) : "#ffffff",
              color: reading ? GETTING_STARTED.deep : INK,
              fontSize: 24,
              fontWeight: 650,
              display: "grid",
              placeItems: "center",
              transform: `scale(${pressRead ? 0.96 : 1})`,
            }}
          >
            {reading ? "Reading…" : readDone ? "Read again" : "Read website"}
          </div>
          <div style={{ ...label, top: 456 }}>Business summary</div>
          <div
            style={{
              ...field,
              top: 490,
              height: 132,
              alignItems: "flex-start",
              paddingTop: 22,
              whiteSpace: "normal",
              lineHeight: 1.35,
              fontSize: 27,
              color: summary ? INK : "#b4b1c4",
            }}
          >
            {summary || "We help…"}
          </div>
          <div
            style={{
              position: "absolute",
              ...local(CONTINUE_BUTTON),
              borderRadius: 999,
              background: VIOLET,
              color: "#ffffff",
              fontSize: 26,
              fontWeight: 750,
              display: "grid",
              placeItems: "center",
              boxShadow: `0 18px 36px -16px ${tint(VIOLET, 0.8)}`,
              transform: `scale(${pressContinue ? 0.95 : 1})`,
            }}
          >
            Continue
          </div>
        </div>
      ) : null}
      {toTeam > 0 ? (
        <div style={{ position: "absolute", inset: 0, opacity: toTeam }}>
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
            Your team.
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
            Hired from your website, ready to start.
          </div>
          {TEAM_ROWS.map((row, i) => {
            const e = easeOutExpo(progress(t, teamRowAt(i, timing), 0.5));
            if (e <= 0) return null;
            const tone = TONES[row.who];
            const top = teamRowY(i) - BUSINESS_CARD.y;
            return (
              <div
                key={row.who}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top,
                  height: 92,
                  opacity: e,
                  transform: `translateY(${((1 - e) * 24).toFixed(2)}px)`,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 52,
                    top: 6,
                    width: 80,
                    height: 80,
                    borderRadius: 40,
                    background: tone.color,
                    display: "grid",
                    placeItems: "center",
                    transform: `scale(${(0.6 + 0.4 * e).toFixed(4)})`,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      width: 52,
                      height: 34,
                      color: "#ffffff",
                    }}
                  >
                    <AntMark />
                  </span>
                </span>
                <div
                  style={{
                    position: "absolute",
                    left: 156,
                    top: 8,
                    fontSize: 34,
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {row.job}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 156,
                    top: 54,
                    fontSize: 22,
                    color: MUTED,
                  }}
                >
                  AI employee
                </div>
                <div
                  style={{
                    position: "absolute",
                    right: 52,
                    top: 24,
                    height: 44,
                    padding: "0 18px",
                    borderRadius: 999,
                    background: tint(tone.color, 0.14),
                    color: tone.deep,
                    fontSize: 21,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  Ready
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

/** The owner's pointer: presses Read website, then Continue. */
export const HowCursor: React.FC<{ t: number; timing: HowTiming }> = ({
  t,
  timing,
}) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.continueClick + 0.6, timing.continueClick + 1.0, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={howCursorKeys(timing)}
      clicks={[timing.readClick, timing.continueClick]}
      opacity={opacity}
    />
  );
};
