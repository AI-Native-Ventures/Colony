import { Cursor } from "../launch/app/Cursor";
import { easeOutExpo, progress, smoothstep } from "../launch/math.ts";
import {
  GETTING_STARTED,
  SCOUT_LOOK,
  TONES,
} from "../launch/wide/employees.ts";
import {
  factAt,
  type HowTiming,
  TEAM_ROWS,
  teamRowAt,
  WORKING_EVERY,
} from "../launch/wide/how.ts";
import { EP02, EP02_FACTS, EP02_WEBSITE } from "./ep02.ts";
import {
  FACT_ROWS,
  FIELD,
  PUSH_DELAY,
  PUSH_SECONDS,
  READ,
  readCursorKeys,
  SCOUT_ROW_TOP,
  TEAM,
} from "./ep02Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import {
  PhoneAvatar,
  PhonePush,
  PhoneTitle,
  PinnedButton,
  tint,
} from "./phoneKit";
import { Tick } from "./RisePostsCard";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = GETTING_STARTED.color;
const W = PHONE_CARD.w - 2 * PHONE_PAD;

/** The film's how timing, and what the episode adds: Scout's row and the owner's yes. */
type Timing = HowTiming & {
  scoutAt?: number;
  approveIn?: number;
  click?: number;
  approvedAt?: number;
};

type Business = { website: string; facts: readonly string[] };
const EP02_BUSINESS: Business = { website: EP02_WEBSITE, facts: EP02_FACTS };

function Subtitle({ text }: { text: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: PHONE_PAD,
        top: 104,
        width: W,
        fontSize: 26,
        color: MUTED,
      }}
    >
      {text}
    </div>
  );
}

/** "Your business.": the website pasted, Colony reading it, what it found. */
function Business({
  t,
  timing,
  business,
}: {
  t: number;
  timing: Timing;
  business: Business;
}) {
  const pasted = t >= timing.pasteAt;
  const flash = pasted ? 1 - progress(t, timing.pasteAt, 0.7) : 0;
  const lastFact = factAt(business.facts.length - 1, timing);
  const reading = t >= timing.readClick && t < lastFact + 0.3;
  const readDone = t >= lastFact + 0.3;
  const scan = progress(t, timing.readClick, lastFact + 0.3 - timing.readClick);
  const press = t >= timing.readClick && t < timing.readClick + 0.14;
  const globe = pasted ? VIOLET : "#b4b1c4";
  return (
    <>
      <PhoneTitle text="Your business." />
      <Subtitle text="Paste your website. Colony does the rest." />
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: FIELD.top,
          width: W,
          height: FIELD.h,
          borderRadius: 28,
          border: `2px solid ${pasted ? tint(VIOLET, 0.55) : LINE}`,
          background: "#faf9fd",
          boxSizing: "border-box",
          boxShadow: pasted ? `0 0 0 6px ${tint(VIOLET, 0.1)}` : undefined,
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "0 30px",
          fontSize: 42,
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
            stroke={globe}
            strokeWidth="1.8"
          />
          <path
            d="M2.5 12h19M12 2.5c3 3 3 16 0 19M12 2.5c-3 3-3 16 0 19"
            fill="none"
            stroke={globe}
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
          {pasted ? business.website : "yourbusiness.com"}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: READ.top,
          width: W,
          height: READ.h,
          borderRadius: 999,
          overflow: "hidden",
          background: reading || readDone ? tint(VIOLET, 0.12) : VIOLET,
          color: reading || readDone ? GETTING_STARTED.deep : "#ffffff",
          fontSize: 30,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          transform: `scale(${press ? 0.97 : 1})`,
        }}
      >
        {reading ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: W * scan,
              background: tint(VIOLET, 0.16),
            }}
          />
        ) : null}
        {readDone ? <Tick size={28} color={GETTING_STARTED.deep} /> : null}
        <span style={{ position: "relative" }}>
          {readDone ? "Website read" : reading ? "Reading…" : "Read website"}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: FACT_ROWS.top - 42,
          fontSize: 24,
          fontWeight: 650,
          color: MUTED,
          opacity: smoothstep(factAt(0, timing) - 0.2, factAt(0, timing), t),
        }}
      >
        What Colony found
      </div>
      {business.facts.map((fact, i) => {
        const e = easeOutExpo(progress(t, factAt(i, timing), 0.45));
        if (e <= 0) return null;
        return (
          <div
            key={fact}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: FACT_ROWS.top + i * FACT_ROWS.step,
              width: W,
              height: FACT_ROWS.h,
              borderRadius: 22,
              background: "#f6f4fb",
              border: `1.5px solid ${LINE}`,
              boxSizing: "border-box",
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "0 24px",
              fontSize: 32,
              fontWeight: 650,
              color: INK,
              opacity: e,
              transform: `translateY(${((1 - e) * 16).toFixed(2)}px)`,
            }}
          >
            <svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24">
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
          </div>
        );
      })}
    </>
  );
}

function StatusChip({
  working,
  color,
  deep,
}: {
  working: boolean;
  color: string;
  deep: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        right: 20,
        top: 30,
        height: 40,
        padding: "0 16px",
        borderRadius: 999,
        background: working ? tint(color, 0.16) : "#f2f1f6",
        color: working ? deep : MUTED,
        fontSize: 21,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {working ? <Tick size={18} color={deep} /> : null}
      {working ? "Working" : "Ready"}
    </div>
  );
}

/** "Your team.": an employee per row as the voice names them, then Scout to lead them. */
function Team({ t, timing }: { t: number; timing: Timing }) {
  const scout =
    timing.scoutAt === undefined
      ? 0
      : easeOutExpo(progress(t, timing.scoutAt, 0.5));
  return (
    <>
      <PhoneTitle text="Your team." />
      <Subtitle text="Hired from your website." />
      {TEAM_ROWS.map((row, i) => {
        const e = easeOutExpo(progress(t, teamRowAt(i, timing), 0.5));
        if (e <= 0) return null;
        const tone = TONES[row.who];
        return (
          <div
            key={row.who}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: TEAM.top + i * TEAM.step,
              width: W,
              height: TEAM.h,
              borderRadius: 24,
              background: "#ffffff",
              border: `2px solid ${LINE}`,
              boxSizing: "border-box",
              boxShadow: `0 16px 30px -22px ${tint(tone.color, 0.85)}`,
              opacity: e,
              transform: `translateX(${((1 - e) * 60).toFixed(2)}px)`,
            }}
          >
            <div style={{ position: "absolute", left: 18, top: 16 }}>
              <PhoneAvatar color={tone.color} size={64} />
            </div>
            <div
              style={{
                position: "absolute",
                left: 102,
                top: 28,
                fontSize: 34,
                fontWeight: 750,
                letterSpacing: "-0.015em",
                color: INK,
              }}
            >
              {row.job}
            </div>
            <StatusChip
              working={
                timing.approvedAt !== undefined &&
                t >= timing.approvedAt + i * WORKING_EVERY
              }
              color={tone.color}
              deep={tone.deep}
            />
          </div>
        );
      })}
      {scout > 0 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: SCOUT_ROW_TOP,
            width: W,
            height: TEAM.h,
            borderRadius: 24,
            background: tint(SCOUT_LOOK.color, 0.08),
            border: `2px solid ${tint(SCOUT_LOOK.color, 0.35)}`,
            boxSizing: "border-box",
            opacity: scout,
            transform: `translateY(${((1 - scout) * 20).toFixed(2)}px)`,
          }}
        >
          <div style={{ position: "absolute", left: 18, top: 16 }}>
            <PhoneAvatar color={SCOUT_LOOK.color} size={64} />
          </div>
          <div
            style={{
              position: "absolute",
              left: 102,
              top: 28,
              fontSize: 34,
              fontWeight: 750,
              color: INK,
            }}
          >
            Scout
          </div>
          <div
            style={{
              position: "absolute",
              right: 20,
              top: 30,
              height: 40,
              padding: "0 16px",
              borderRadius: 999,
              background: tint(SCOUT_LOOK.color, 0.16),
              color: SCOUT_LOOK.deep,
              fontSize: 21,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
            }}
          >
            Leads the team
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Episode 2's work on the phone card (or the film's, given its business and
 * timing): your website read, the team hired, and your yes when the timing
 * has one.
 */
export const TeamPhone: React.FC<{
  t: number;
  timing?: Timing;
  business?: Business;
}> = ({ t, timing = EP02, business = EP02_BUSINESS }) => {
  const yes =
    timing.approveIn !== undefined &&
    timing.click !== undefined &&
    timing.approvedAt !== undefined
      ? {
          approveIn: timing.approveIn,
          click: timing.click,
          doneAt: timing.approvedAt,
        }
      : null;
  return (
    <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(258 60% 40% / 0.45)">
      <PhonePush
        t={t}
        at={timing.continueClick + PUSH_DELAY}
        seconds={PUSH_SECONDS}
        first={<Business t={t} timing={timing} business={business} />}
        second={<Team t={t} timing={timing} />}
      />
      {yes ? (
        <PinnedButton
          t={t}
          tone={GETTING_STARTED}
          idle="Hire my team"
          done="Team hired"
          timing={yes}
        />
      ) : null}
    </PhoneCard>
  );
};

/** The pointer onto Read website. Frame pixels. */
export const ReadCursor: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP02,
}) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.readClick + 0.7, timing.readClick + 1.1, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={readCursorKeys(timing)}
      clicks={[timing.readClick]}
      opacity={opacity}
    />
  );
};
