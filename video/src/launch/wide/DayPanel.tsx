import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import {
  chipShowsAt,
  clockHours,
  clockLabel,
  DAY_CHIP_H,
  DAY_END,
  DAY_LANE_TOP,
  DAY_START,
  dayLaneY,
  type DayTiming,
  hourX,
  RULER,
  TEAM_CHIPS,
  YOU_BLOCKS,
} from "./day.ts";
import { PersonGlyph } from "./EmployeeHero";
import { OWNER, TEAM, TONES } from "./employees.ts";
import { WorkerAnt } from "./WorkerAnt";

export type DayPanelTiming = DayTiming & { titleAt: number };

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = OWNER.color;
const RULER_Y = 330;
const YOU_Y = 386;
const YOU_H = 84;
const CHIP_H = DAY_CHIP_H;
const CHIP_FONT = 22;

let measureCtx: CanvasRenderingContext2D | null = null;

/** Chip text width in px, measured in Inter (fonts load before any frame renders). */
function textWidth(text: string): number {
  if (!measureCtx)
    measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 12.5;
  measureCtx.font = `650 ${CHIP_FONT}px "${INTER}"`;
  return measureCtx.measureText(text).width;
}

const laneY = dayLaneY;

function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
}

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

function AntBadge({ color, size }: { color: string; size: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: color,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: "flex",
          width: size * 0.62,
          height: size * 0.41,
          color: "#ffffff",
        }}
      >
        <AntMark />
      </span>
    </span>
  );
}

const SUMMARY = [
  { who: "blue", text: "11 new customers" },
  { who: "amber", text: "2 meetings booked" },
  { who: "pink", text: "4 posts" },
  { who: "green", text: "Website updated" },
] as const;

/** Your day back: a running clock, your jobs on one lane, your team's wins on four more. */
export const DayPanel: React.FC<{ t: number; timing: DayPanelTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.titleAt, 0.8));
  if (enter <= 0) return null;
  const hours = clockHours(t, timing);
  const nowX = hourX(hours);
  const running = t >= timing.clockFrom && t <= timing.clockTo;
  const walk =
    smoothstep(timing.clockFrom - 0.1, timing.clockFrom + 0.2, t) *
    (1 - smoothstep(timing.clockTo - 0.2, timing.clockTo + 0.1, t));
  const lanesIn = easeOutExpo(progress(t, timing.titleAt + 0.2, 0.8));
  const sunHue = 45 - ((hours - DAY_START) / (DAY_END - DAY_START)) * 75;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: INTER,
        color: INK,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: nowX - 520,
          top: -420,
          width: 1040,
          height: 900,
          background: `radial-gradient(closest-side, hsl(${sunHue.toFixed(1)} 95% 70% / 0.3), transparent)`,
          opacity: enter,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 92,
          fontSize: 136,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
          opacity: enter,
          transform: `translateY(${((1 - enter) * 30).toFixed(2)}px)`,
        }}
      >
        {clockLabel(t, timing)}
      </div>
      <div
        style={{
          position: "absolute",
          left: 588,
          top: 170,
          fontSize: 34,
          fontWeight: 650,
          color: MUTED,
          opacity: enter,
        }}
      >
        Tuesday
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: lanesIn }}>
        <div
          style={{
            position: "absolute",
            left: RULER.x0,
            width: RULER.x1 - RULER.x0,
            top: RULER_Y,
            height: 1.5,
            background: LINE,
          }}
        />
        {Array.from({ length: DAY_END - DAY_START + 1 }, (_, k) => {
          const h = DAY_START + k;
          return (
            <div key={h}>
              <div
                style={{
                  position: "absolute",
                  left: hourX(h) - 1,
                  top: RULER_Y - 10,
                  width: 2,
                  height: 10,
                  background: "#d9d5e6",
                }}
              />
              {h % 2 === 1 ? (
                <div
                  style={{
                    position: "absolute",
                    left: hourX(h) - 40,
                    width: 80,
                    top: RULER_Y - 44,
                    textAlign: "center",
                    fontSize: 20,
                    fontWeight: 600,
                    color: "#9a97ad",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              ) : null}
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            left: 60,
            top: YOU_Y + 20,
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 28,
            fontWeight: 750,
          }}
        >
          <span
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              background: VIOLET,
              display: "grid",
              placeItems: "center",
            }}
          >
            <PersonGlyph size={28} />
          </span>
          You
        </div>
        {YOU_BLOCKS.map((block) => {
          const shownTo = Math.min(block.to, hours);
          if (shownTo <= block.from) return null;
          return (
            <div
              key={block.text}
              style={{
                position: "absolute",
                left: hourX(block.from),
                width: hourX(shownTo) - hourX(block.from),
                top: YOU_Y,
                height: YOU_H,
                borderRadius: 18,
                background: "#211d30",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 22,
                  top: 0,
                  height: YOU_H,
                  display: "flex",
                  alignItems: "center",
                  whiteSpace: "nowrap",
                  fontSize: 24,
                  fontWeight: 650,
                  color: "#ffffff",
                }}
              >
                {block.text}
              </div>
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            left: 60,
            top: DAY_LANE_TOP - 4,
            fontSize: 28,
            fontWeight: 750,
            lineHeight: 1.15,
          }}
        >
          Your
          <br />
          team
        </div>
        {TEAM.map((who, k) => (
          <div
            key={who}
            style={{
              position: "absolute",
              left: RULER.x0,
              width: RULER.x1 - RULER.x0,
              top: laneY(k) + CHIP_H / 2,
              height: 0,
              borderTop: "2px dashed #ebe8f3",
            }}
          />
        ))}
        {TEAM_CHIPS.map((chip) => {
          const showAt = chipShowsAt(chip, timing);
          const pop = progress(t, showAt, 0.38);
          if (pop <= 0) return null;
          const k = TEAM.indexOf(chip.who);
          const width = 72 + textWidth(chip.text);
          const scale = 0.6 + 0.4 * easeOutBack(pop);
          return (
            <div
              key={`${chip.who}-${chip.at}`}
              style={{
                position: "absolute",
                left: hourX(chip.at) - width,
                top: laneY(k),
                width,
                height: CHIP_H,
                borderRadius: 999,
                background: "#ffffff",
                border: `1.5px solid ${LINE}`,
                boxShadow: `0 14px 28px -18px ${tint(TONES[chip.who].color, 0.7)}`,
                display: "flex",
                alignItems: "center",
                gap: 10,
                paddingLeft: 10,
                boxSizing: "border-box",
                fontSize: CHIP_FONT,
                fontWeight: 650,
                whiteSpace: "nowrap",
                opacity: Math.min(1, pop * 2.5),
                transform: `scale(${scale.toFixed(4)})`,
                transformOrigin: "100% 50%",
              }}
            >
              <AntBadge color={TONES[chip.who].color} size={38} />
              {chip.text}
            </div>
          );
        })}
        {t >= timing.clockFrom - 0.3 ? (
          <>
            <div
              style={{
                position: "absolute",
                left: nowX - 1.5,
                top: RULER_Y - 8,
                width: 3,
                height: laneY(TEAM.length - 1) + CHIP_H + 10 - (RULER_Y - 8),
                background: VIOLET,
                opacity: smoothstep(
                  timing.clockFrom - 0.3,
                  timing.clockFrom,
                  t,
                ),
              }}
            />
            <div
              style={{
                position: "absolute",
                left: nowX - 8,
                top: RULER_Y - 16,
                width: 16,
                height: 16,
                borderRadius: 8,
                background: VIOLET,
                boxShadow: `0 0 0 6px ${tint(VIOLET, 0.18)}`,
              }}
            />
          </>
        ) : null}
        {TEAM.map((who, k) => (
          <WorkerAnt
            key={who}
            x={nowX + 36}
            y={laneY(k) + CHIP_H / 2}
            angle={0}
            size={46}
            color={TONES[who].color}
            phase={running ? (t - timing.clockFrom) * 4.2 + k * 0.27 : 0}
            amp={walk}
          />
        ))}
      </div>
      {t >= timing.summaryAt ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 900,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 16,
          }}
        >
          <span
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: MUTED,
              marginRight: 6,
              opacity: easeOutExpo(progress(t, timing.summaryAt, 0.4)),
            }}
          >
            Today
          </span>
          {SUMMARY.map((item, i) => {
            const e = easeOutExpo(
              progress(t, timing.summaryAt + 0.1 + i * 0.12, 0.5),
            );
            const tone = TONES[item.who];
            return (
              <span
                key={item.who}
                style={{
                  height: 60,
                  padding: "0 24px",
                  borderRadius: 999,
                  background: tint(tone.color, 0.14),
                  color: tone.deep,
                  fontSize: 27,
                  fontWeight: 750,
                  display: "inline-flex",
                  alignItems: "center",
                  opacity: e,
                  transform: `translateY(${((1 - e) * 18).toFixed(2)}px)`,
                }}
              >
                {item.text}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
