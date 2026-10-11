import { AntMark } from "../../brand/AntMark";
import { Cursor } from "../app/Cursor";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import { GETTING_STARTED, TONES } from "./employees.ts";
import {
  BUSINESS_CARD,
  CONTINUE_BUTTON,
  FACTS,
  factAt,
  type HowTiming,
  howCursorKeys,
  READ_BUTTON,
  TEAM_ROWS,
  teamRowAt,
  teamRowY,
  WEBSITE,
  WEBSITE_FIELD,
} from "./how.ts";

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

/** Paste the website into one big field, see what Colony read, then the team it hired. */
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
  const flash = pasted ? 1 - progress(t, timing.pasteAt, 0.7) : 0;
  const lastFact = factAt(FACTS.length - 1, timing);
  const reading = t >= timing.readClick && t < lastFact + 0.3;
  const readDone = t >= lastFact + 0.3;
  const scan = progress(t, timing.readClick, lastFact + 0.3 - timing.readClick);
  const pressRead = t >= timing.readClick && t < timing.readClick + 0.14;
  const pressContinue =
    t >= timing.continueClick && t < timing.continueClick + 0.14;
  const field = local(WEBSITE_FIELD);
  const read = local(READ_BUTTON);
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
            Paste your website. Colony does the rest.
          </div>
          <div
            style={{
              position: "absolute",
              left: field.left,
              top: field.top,
              width: field.width,
              height: field.height,
              borderRadius: 26,
              border: `2px solid ${pasted ? tint(VIOLET, 0.55) : LINE}`,
              background: FIELD_BG,
              boxShadow: pasted ? `0 0 0 6px ${tint(VIOLET, 0.1)}` : undefined,
              display: "flex",
              alignItems: "center",
              gap: 20,
              padding: "0 34px",
              fontSize: 46,
              fontWeight: 650,
              letterSpacing: "-0.02em",
              color: pasted ? INK : "#b4b1c4",
              whiteSpace: "nowrap",
            }}
          >
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24">
              <circle
                cx="12"
                cy="12"
                r="9.5"
                fill="none"
                stroke={pasted ? VIOLET : "#b4b1c4"}
                strokeWidth="1.8"
              />
              <path
                d="M2.5 12h19M12 2.5c3 3 3 16 0 19M12 2.5c-3 3-3 16 0 19"
                fill="none"
                stroke={pasted ? VIOLET : "#b4b1c4"}
                strokeWidth="1.8"
              />
            </svg>
            <span
              style={{
                background: flash > 0 ? tint(VIOLET, 0.22 * flash) : undefined,
                borderRadius: 8,
                padding: "0 4px",
              }}
            >
              {pasted ? WEBSITE : "yourbusiness.com"}
            </span>
          </div>
          <div
            style={{
              position: "absolute",
              left: read.left,
              top: read.top,
              width: read.width,
              height: read.height,
              borderRadius: 999,
              background: reading || readDone ? tint(VIOLET, 0.12) : VIOLET,
              color: reading || readDone ? GETTING_STARTED.deep : "#ffffff",
              fontSize: 27,
              fontWeight: 750,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              transform: `scale(${pressRead ? 0.95 : 1})`,
            }}
          >
            {readDone ? (
              <svg
                aria-hidden="true"
                width="24"
                height="24"
                viewBox="0 0 24 24"
              >
                <path
                  d="M5 12.5l4.2 4.2L19 7"
                  fill="none"
                  stroke={GETTING_STARTED.deep}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
            {readDone
              ? "Website read"
              : reading
                ? "Reading\u2026"
                : "Read website"}
          </div>
          {reading ? (
            <div
              style={{
                position: "absolute",
                left: read.left + read.width + 28,
                top: read.top + read.height / 2 - 3,
                width: (field.width - read.width - 28) * scan,
                height: 6,
                borderRadius: 3,
                background: VIOLET,
              }}
            />
          ) : null}
          <div
            style={{
              position: "absolute",
              left: 52,
              top: read.top + read.height + 22,
              fontSize: 22,
              fontWeight: 600,
              color: MUTED,
              opacity: smoothstep(
                factAt(0, timing) - 0.2,
                factAt(0, timing),
                t,
              ),
            }}
          >
            What Colony found
          </div>
          <div
            style={{
              position: "absolute",
              left: 52,
              right: 52,
              top: read.top + read.height + 58,
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
            }}
          >
            {FACTS.map((fact, i) => {
              const e = easeOutExpo(progress(t, factAt(i, timing), 0.45));
              return (
                <span
                  key={fact}
                  style={{
                    height: 62,
                    padding: "0 28px 0 20px",
                    borderRadius: 999,
                    background: "#f6f4fb",
                    border: `1.5px solid ${LINE}`,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 12,
                    fontSize: 29,
                    fontWeight: 650,
                    opacity: e,
                    transform: `translateY(${((1 - e) * 16).toFixed(2)}px) scale(${(0.9 + 0.1 * e).toFixed(4)})`,
                  }}
                >
                  <svg
                    aria-hidden="true"
                    width="26"
                    height="26"
                    viewBox="0 0 24 24"
                  >
                    <circle cx="12" cy="12" r="11" fill={tint(VIOLET, 0.16)} />
                    <path
                      d="M7 12.5l3.2 3.2L17 9"
                      fill="none"
                      stroke={GETTING_STARTED.deep}
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {fact}
                </span>
              );
            })}
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
              opacity: smoothstep(lastFact, lastFact + 0.3, t),
            }}
          >
            Hire my team
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
                  height: 104,
                  opacity: e,
                  transform: `translateY(${((1 - e) * 24).toFixed(2)}px)`,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    left: 52,
                    top: 4,
                    width: 96,
                    height: 96,
                    borderRadius: 48,
                    background: tone.color,
                    display: "grid",
                    placeItems: "center",
                    boxShadow: `0 14px 30px -14px ${tint(tone.color, 0.8)}`,
                    transform: `scale(${(0.6 + 0.4 * e).toFixed(4)})`,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      width: 60,
                      height: 40,
                      color: "#ffffff",
                    }}
                  >
                    <AntMark />
                  </span>
                </span>
                <div
                  style={{
                    position: "absolute",
                    left: 176,
                    top: 12,
                    fontSize: 40,
                    fontWeight: 750,
                    letterSpacing: "-0.02em",
                  }}
                >
                  {row.job}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 176,
                    top: 62,
                    fontSize: 24,
                    color: MUTED,
                  }}
                >
                  AI employee
                </div>
                <div
                  style={{
                    position: "absolute",
                    right: 52,
                    top: 28,
                    height: 50,
                    padding: "0 22px",
                    borderRadius: 999,
                    background: tint(tone.color, 0.14),
                    color: tone.deep,
                    fontSize: 25,
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
