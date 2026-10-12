import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";
import {
  chipShowsAt,
  clockHours,
  clockLabel,
  DAY_END,
  DAY_START,
  TEAM_CHIPS,
  YOU_BLOCKS,
} from "../wide/day.ts";
import { AntBadge, type DayPanelTiming } from "../wide/DayPanel";
import { easeOutBack, PersonGlyph } from "../wide/EmployeeHero";
import { OWNER, TEAM, TONES } from "../wide/employees.ts";
import { WorkerAnt } from "../wide/WorkerAnt";
import {
  chipTops,
  hourY,
  SUMMARY_ROWS,
  summaryBox,
  TALL_DAY,
  tallDayAntSpot,
  youBlockLines,
} from "./day.ts";

const D = TALL_DAY;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = OWNER.color;
const CHIP_TOPS = chipTops(TEAM_CHIPS);

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

/** The ruler down the left: a tick every hour, a label every other hour. */
const HourRuler: React.FC = () => (
  <>
    <div
      style={{
        position: "absolute",
        left: D.ruler.x - 0.75,
        top: D.ruler.top,
        width: 1.5,
        height: D.ruler.bottom - D.ruler.top,
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
              left: D.ruler.x - 10,
              top: hourY(h) - 1,
              width: 10,
              height: 2,
              background: "#d9d5e6",
            }}
          />
          {h % 2 === 1 ? (
            <div
              style={{
                position: "absolute",
                left: D.ruler.x - 100,
                width: 84,
                top: hourY(h) - 14,
                height: 28,
                lineHeight: "28px",
                textAlign: "right",
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
  </>
);

/** "Today": the film's four results in two rows, centred under 18:00. */
const Summary: React.FC<{ t: number; at: number }> = ({ t, at }) => {
  const box = summaryBox();
  const s = D.summary;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: s.label,
          lineHeight: `${s.label}px`,
          textAlign: "center",
          fontSize: 26,
          fontWeight: 700,
          color: MUTED,
          opacity: easeOutExpo(progress(t, at, 0.4)),
        }}
      >
        Today
      </div>
      {SUMMARY_ROWS.map((row, r) => (
        <div
          key={row[0].who}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: s.label + s.gap + r * (s.row + s.rowGap),
            display: "flex",
            justifyContent: "center",
            gap: 14,
          }}
        >
          {row.map((item, j) => {
            const e = easeOutExpo(
              progress(t, at + 0.1 + (r * row.length + j) * 0.12, 0.5),
            );
            const tone = TONES[item.who];
            return (
              <span
                key={item.who}
                style={{
                  height: s.row,
                  padding: "0 24px",
                  borderRadius: 999,
                  background: tint(tone.color, 0.14),
                  color: tone.deep,
                  fontSize: s.font,
                  fontWeight: 750,
                  display: "inline-flex",
                  alignItems: "center",
                  whiteSpace: "nowrap",
                  opacity: e,
                  transform: `translateY(${((1 - e) * 18).toFixed(2)}px)`,
                }}
              >
                {item.text}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

/** Your day back on the tall frame: the clock on top, your jobs and your team's wins running down the page. */
export const TallDay: React.FC<{ t: number; timing: DayPanelTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.titleAt, 0.8));
  if (enter <= 0) return null;
  const hours = clockHours(t, timing);
  const nowY = hourY(hours);
  const running = t >= timing.clockFrom && t <= timing.clockTo;
  const walk =
    smoothstep(timing.clockFrom - 0.1, timing.clockFrom + 0.2, t) *
    (1 - smoothstep(timing.clockTo - 0.2, timing.clockTo + 0.1, t));
  const lanesIn = easeOutExpo(progress(t, timing.titleAt + 0.2, 0.8));
  const sunHue = 45 - ((hours - DAY_START) / (DAY_END - DAY_START)) * 75;
  const lineRight = D.team.x + D.team.w;
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
          left: 0,
          top: nowY - 450,
          width: 1080,
          height: 900,
          background: `radial-gradient(closest-side, hsl(${sunHue.toFixed(1)} 95% 70% / 0.3), transparent)`,
          opacity: enter,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: D.clock.x,
          top: D.clock.y,
          fontSize: D.clock.size,
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
          left: D.weekday.x,
          top: D.weekday.y,
          fontSize: D.weekday.size,
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
            left: D.you.x,
            top: D.heads.y,
            height: 44,
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
        <div
          style={{
            position: "absolute",
            left: D.team.x,
            top: D.heads.y,
            height: 44,
            display: "flex",
            alignItems: "center",
            fontSize: 28,
            fontWeight: 750,
          }}
        >
          Your team
        </div>
        <HourRuler />
        {TEAM.map((who, k) => (
          <div
            key={who}
            style={{
              position: "absolute",
              left: tallDayAntSpot(k, DAY_START).x - 1,
              top: D.ruler.top,
              width: 0,
              height: D.ruler.bottom - D.ruler.top,
              borderLeft: "2px dashed #ebe8f3",
            }}
          />
        ))}
        {YOU_BLOCKS.map((block) => {
          const shownTo = Math.min(block.to, hours);
          if (shownTo <= block.from) return null;
          return (
            <div
              key={block.text}
              style={{
                position: "absolute",
                left: D.you.x,
                width: D.you.w,
                top: hourY(block.from),
                height: hourY(shownTo) - hourY(block.from),
                borderRadius: 18,
                background: "#211d30",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: D.block.pad,
                  top: D.block.pad,
                  fontSize: D.block.font,
                  lineHeight: `${D.block.lineHeight}px`,
                  fontWeight: 650,
                  color: "#ffffff",
                  whiteSpace: "nowrap",
                }}
              >
                {youBlockLines(block.text).map((words) => (
                  <div key={words}>{words}</div>
                ))}
              </div>
            </div>
          );
        })}
        {TEAM_CHIPS.map((chip, i) => {
          const pop = progress(t, chipShowsAt(chip, timing), 0.38);
          if (pop <= 0) return null;
          const scale = 0.6 + 0.4 * easeOutBack(pop);
          return (
            <div
              key={`${chip.who}-${chip.at}`}
              style={{
                position: "absolute",
                left: D.team.x,
                top: CHIP_TOPS[i],
                height: D.chip.h,
                borderRadius: 999,
                background: "#ffffff",
                border: `1.5px solid ${LINE}`,
                boxShadow: `0 14px 28px -18px ${tint(TONES[chip.who].color, 0.7)}`,
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0 22px 0 9px",
                boxSizing: "border-box",
                fontSize: D.chip.font,
                fontWeight: 650,
                whiteSpace: "nowrap",
                opacity: Math.min(1, pop * 2.5),
                transform: `scale(${scale.toFixed(4)})`,
                transformOrigin: "0% 100%",
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
                left: D.ruler.x,
                top: nowY - 1.5,
                width: lineRight - D.ruler.x,
                height: 3,
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
                left: D.ruler.x - 8,
                top: nowY - 8,
                width: 16,
                height: 16,
                borderRadius: 8,
                background: VIOLET,
                boxShadow: `0 0 0 6px ${tint(VIOLET, 0.18)}`,
              }}
            />
          </>
        ) : null}
        {TEAM.map((who, k) => {
          const spot = tallDayAntSpot(k, hours);
          return (
            <WorkerAnt
              key={who}
              x={spot.x}
              y={spot.y}
              angle={Math.PI / 2}
              size={46}
              color={TONES[who].color}
              phase={running ? (t - timing.clockFrom) * 4.2 + k * 0.27 : 0}
              amp={walk}
            />
          );
        })}
      </div>
      {t >= timing.summaryAt ? <Summary t={t} at={timing.summaryAt} /> : null}
    </div>
  );
};
