import { INTER } from "../fonts";
import { easeOutExpo, lerpAngle, progress, smoothstep } from "../math.ts";
import {
  BEAT,
  type BoardTiming,
  BOARD,
  carryPath,
  carryStart,
  foundCount,
  LEADS,
  type Lead,
  landsAt,
  rowY,
  TICK_BOX,
} from "./beat.ts";
import { walkState } from "./walk.ts";
import { WorkerAnt } from "./WorkerAnt";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const BLUE = "hsl(217 91% 60%)";
const COLS = {
  company: BOARD.x + 110,
  area: BOARD.x + 520,
  score: BOARD.x + 790,
  why: BOARD.x + 470,
};
const SUBTITLE = "Find and manage the businesses your company can serve.";

function Placeholder({ left, width }: { left: number; width: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left,
        top: 27,
        width,
        height: 20,
        borderRadius: 10,
        background: "#f3f1f8",
      }}
    />
  );
}

/** The owner's tick on a row: an empty box, then blue with a tick from `at`. */
function TickBox({ t, at }: { t: number; at: number }) {
  const on = t >= at;
  const bump = on ? 1 - progress(t, at, 0.3) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: TICK_BOX.left,
        top: TICK_BOX.top,
        width: TICK_BOX.size,
        height: TICK_BOX.size,
        borderRadius: 10,
        boxSizing: "border-box",
        border: on ? "none" : "2px solid #d4d0e2",
        background: on ? BLUE : "#ffffff",
        display: "grid",
        placeItems: "center",
        transform: `scale(${(1 + 0.18 * bump).toFixed(4)})`,
      }}
    >
      {on ? (
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
          <path
            d="M5 12.5l4.2 4.2L19 7"
            fill="none"
            stroke="#ffffff"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </div>
  );
}

/** The real Leads screen as one big flat card, its rows filling as carriers land. */
export const LeadsBoard: React.FC<{
  t: number;
  timing?: BoardTiming;
  /** Defaults are the launch film's Sandton leads. */
  leads?: readonly Lead[];
  /** "" leaves room for the owner's request under the title. */
  subtitle?: string;
  /** Rows show why each lead fits instead of area and score, revealed from `at`, one row every `every` seconds. */
  reasons?: { at: number; every: number };
  /** Rows the owner ticks, and when; their boxes show once the reasons do. */
  picks?: readonly { row: number; at: number }[];
}> = ({
  t,
  timing = BEAT,
  leads = LEADS,
  subtitle = SUBTITLE,
  reasons,
  picks,
}) => {
  const enter = easeOutExpo(progress(t, timing.boardIn, 0.9));
  if (enter <= 0) return null;
  const count = foundCount(t, timing, leads.length);
  const columns = reasons
    ? [
        { label: "Company", x: COLS.company },
        { label: "Why it fits", x: COLS.why },
      ]
    : [
        { label: "Company", x: COLS.company },
        { label: "Area", x: COLS.area },
        { label: "Score", x: COLS.score },
      ];
  const bump = Math.max(
    0,
    ...leads.map((_, i) =>
      t >= landsAt(i, timing) ? 1 - progress(t, landsAt(i, timing), 0.28) : 0,
    ),
  );
  return (
    <div
      style={{
        position: "absolute",
        left: BOARD.x,
        top: BOARD.y,
        width: BOARD.w,
        height: BOARD.h,
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
        Leads.
      </div>
      {subtitle ? (
        <div
          style={{
            position: "absolute",
            left: 52,
            top: 116,
            fontSize: 24,
            color: MUTED,
          }}
        >
          {subtitle}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 54,
          height: 64,
          padding: "0 28px",
          borderRadius: 999,
          background: "hsl(217 91% 60% / 0.12)",
          color: "hsl(217 80% 44%)",
          fontSize: 32,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          fontVariantNumeric: "tabular-nums",
          transform: `scale(${(1 + 0.08 * bump).toFixed(4)})`,
        }}
      >
        {count} found
      </div>
      {columns.map((col) => (
        <div
          key={col.label}
          style={{
            position: "absolute",
            left: col.x - BOARD.x,
            top: 186,
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#9a97ad",
          }}
        >
          {col.label}
        </div>
      ))}
      {leads.map((lead, i) => {
        const top = rowY(i) - BOARD.y;
        const e = easeOutExpo(progress(t, landsAt(i, timing), 0.45));
        const why = reasons
          ? easeOutExpo(progress(t, reasons.at + i * reasons.every, 0.4))
          : 0;
        const pick = picks?.find((p) => p.row === i);
        return (
          <div
            key={lead.name}
            style={{ position: "absolute", left: 0, right: 0, top, height: 76 }}
          >
            <div
              style={{
                position: "absolute",
                left: 40,
                right: 40,
                bottom: 0,
                height: 1.5,
                background: LINE,
              }}
            />
            {e <= 0 ? (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: COLS.company - BOARD.x,
                    top: 27,
                    width: 300,
                    height: 20,
                    borderRadius: 10,
                    background: "#f3f1f8",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: (reasons ? COLS.why : COLS.area) - BOARD.x,
                    top: 27,
                    width: reasons ? 240 : 150,
                    height: 20,
                    borderRadius: 10,
                    background: "#f3f1f8",
                  }}
                />
              </>
            ) : (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: e,
                  transform: `translateX(${((1 - e) * -24).toFixed(2)}px)`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: COLS.company - BOARD.x,
                    top: 20,
                    fontSize: 28,
                    fontWeight: 650,
                  }}
                >
                  {lead.name}
                </div>
                {reasons ? (
                  <>
                    {why <= 0 ? (
                      <Placeholder left={COLS.why - BOARD.x} width={240} />
                    ) : (
                      <div
                        style={{
                          position: "absolute",
                          left: COLS.why - BOARD.x,
                          top: 22,
                          fontSize: 25,
                          color: MUTED,
                          opacity: why,
                          transform: `translateY(${((1 - why) * 10).toFixed(2)}px)`,
                        }}
                      >
                        {lead.why}
                      </div>
                    )}
                    {picks && why > 0 ? (
                      <div style={{ opacity: why }}>
                        <TickBox
                          t={t}
                          at={pick ? pick.at : Number.POSITIVE_INFINITY}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div
                      style={{
                        position: "absolute",
                        left: COLS.area - BOARD.x,
                        top: 22,
                        fontSize: 25,
                        color: MUTED,
                      }}
                    >
                      {lead.area}
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        left: COLS.score - BOARD.x,
                        top: 16,
                        height: 42,
                        padding: "0 16px",
                        borderRadius: 999,
                        background: "hsl(160 60% 45% / 0.14)",
                        color: "hsl(160 60% 30%)",
                        fontSize: 24,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {lead.score}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** Blue ants carrying each lead in like leaf-cutters, then settling as the row's owner. */
export const Carriers: React.FC<{
  t: number;
  timing?: BoardTiming;
  leads?: readonly Lead[];
}> = ({ t, timing = BEAT, leads = LEADS }) => (
  <>
    {leads.map((lead, i) => {
      const start = carryStart(i, timing);
      if (t < start) return null;
      const s = walkState(carryPath(i), t, start, timing.carryDuration);
      const land = landsAt(i, timing);
      const settle = smoothstep(land, land + 0.35, t);
      const angle = lerpAngle(s.angle, 0, settle);
      const tagGone = smoothstep(land - 0.05, land + 0.22, t);
      const sway = 2.2 * Math.sin(s.phase * Math.PI * 2) * s.amp;
      return (
        <div key={lead.name}>
          {tagGone < 1 ? (
            <div
              style={{
                position: "absolute",
                left: s.x - 30,
                top: s.y - 74,
                width: 60,
                height: 42,
                borderRadius: 10,
                background: "#ffffff",
                border: "1.5px solid #e2ddf0",
                boxShadow: "0 10px 22px -10px hsl(217 60% 30% / 0.5)",
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
                  background: BLUE,
                  color: "#fff",
                  fontFamily: INTER,
                  fontSize: 13,
                  fontWeight: 700,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {lead.name[0]}
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
            size={72}
            color={BLUE}
            phase={s.phase}
            amp={s.amp}
          />
        </div>
      );
    })}
  </>
);
