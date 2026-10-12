import { Cursor } from "../launch/app/Cursor";
import {
  easeOutExpo,
  lerpAngle,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { easeOutBack } from "../launch/wide/EmployeeHero";
import { carryStart, foundCount, landsAt } from "../launch/wide/beat.ts";
import { TONES } from "../launch/wide/employees.ts";
import { walkState } from "../launch/wide/walk.ts";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import {
  EP03,
  EP03_BEATS,
  EP03_LEADS,
  EP03_PICKS,
  EP03_REQUEST,
} from "./ep03.ts";
import {
  LEAD_ROWS,
  leadCarryPath,
  NAME_LEFT,
  PICK_ROWS,
  pickLandsAt,
  PUSH_AT,
  PUSH_SECONDS,
  restCursorKeys,
  TICK_SIZE,
  tickCursorKeys,
} from "./ep03Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import {
  PhonePill,
  PhonePush,
  PhoneRequest,
  PhoneTitle,
  PinnedButton,
  tint,
} from "./phoneKit";
import { Tick } from "./RisePostsCard";

const BLUE = TONES.blue;
const AMBER = TONES.amber;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const W = PHONE_CARD.w - 2 * PHONE_PAD;

type Timing = typeof EP03;

/** One lead's row: its name once its ant lands, why it fits, the tick box, ticked if picked. */
function LeadRow({ t, i, timing }: { t: number; i: number; timing: Timing }) {
  const lead = EP03_LEADS[i];
  const top = LEAD_ROWS.top + i * LEAD_ROWS.step;
  const name = easeOutExpo(progress(t, landsAt(i, timing) - 0.05, 0.35));
  const why = easeOutExpo(
    progress(t, timing.reasonsAt + i * timing.reasonsEvery, 0.4),
  );
  const pick = EP03_PICKS.find((p) => p.row === i);
  const ticked = pick ? smoothstep(pick.at, pick.at + 0.2, t) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        right: 20,
        top,
        height: LEAD_ROWS.h,
        borderRadius: 22,
        background:
          ticked > 0 ? tint(BLUE.color, 0.08 * ticked) : "transparent",
        borderBottom: ticked > 0 ? undefined : `1.5px solid ${LINE}`,
      }}
    >
      {name > 0 ? (
        <div
          style={{
            position: "absolute",
            left: NAME_LEFT - 20,
            top: why > 0 ? 8 : 22,
            fontSize: 30,
            fontWeight: 750,
            letterSpacing: "-0.015em",
            color: INK,
            opacity: name,
            whiteSpace: "nowrap",
          }}
        >
          {lead.name}
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: NAME_LEFT - 20,
            top: 30,
            width: 300,
            height: 18,
            borderRadius: 9,
            background: "#f1eff6",
          }}
        />
      )}
      {why > 0 ? (
        <div
          style={{
            position: "absolute",
            left: NAME_LEFT - 20,
            top: 46,
            fontSize: 24,
            color: MUTED,
            opacity: why,
            whiteSpace: "nowrap",
          }}
        >
          {lead.why}
        </div>
      ) : null}
      {why > 0 ? (
        <div
          style={{
            position: "absolute",
            right: PHONE_PAD - 20,
            top: (LEAD_ROWS.h - TICK_SIZE) / 2,
            width: TICK_SIZE,
            height: TICK_SIZE,
            borderRadius: 12,
            border: ticked > 0 ? "none" : "2.5px solid #d6d2e4",
            background: ticked > 0 ? BLUE.color : "#ffffff",
            boxSizing: "border-box",
            display: "grid",
            placeItems: "center",
            opacity: why,
            transform: `scale(${(1 + 0.15 * Math.sin(Math.PI * ticked)).toFixed(4)})`,
          }}
        >
          {ticked > 0 ? <Tick size={28} color="#ffffff" /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Blue ants carrying each lead in on a little tag; each settles at its row's left. Card pixels. */
function LeadCarriers({ t, timing }: { t: number; timing: Timing }) {
  return (
    <>
      {EP03_LEADS.map((lead, i) => {
        const start = carryStart(i, timing);
        if (t < start) return null;
        const s = walkState(leadCarryPath(i), t, start, timing.carryDuration);
        const land = landsAt(i, timing);
        const settle = smoothstep(land, land + 0.35, t);
        const tagGone = smoothstep(land - 0.05, land + 0.22, t);
        return (
          <div key={lead.name}>
            {tagGone < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: s.x - 24,
                  top: s.y - 58,
                  width: 48,
                  height: 34,
                  borderRadius: 9,
                  background: "#ffffff",
                  border: "1.5px solid #e2ddf0",
                  boxShadow: "0 8px 18px -8px hsl(217 60% 30% / 0.5)",
                  opacity: 1 - tagGone,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    background: BLUE.color,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 700,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  {lead.name[0]}
                </span>
              </div>
            ) : null}
            <WorkerAnt
              x={s.x}
              y={s.y}
              angle={lerpAngle(s.angle, 0, settle)}
              size={46}
              color={BLUE.color}
              phase={s.phase}
              amp={s.amp}
            />
          </div>
        );
      })}
    </>
  );
}

/** "Leads.": your request, the leads carried in, why each fits, your picks. */
function Leads({ t, timing }: { t: number; timing: Timing }) {
  const found = foundCount(t, timing, EP03_LEADS.length);
  const shown = smoothstep(timing.carryFrom, timing.carryFrom + 0.3, t);
  const rushEnd = timing.countRushFrom + timing.countRush;
  const bump = t >= rushEnd ? 1 - progress(t, rushEnd, 0.4) : 0;
  return (
    <>
      <PhoneTitle text="Leads." />
      <PhonePill
        label={`${found} found`}
        tone={BLUE}
        opacity={shown}
        bump={bump}
      />
      <PhoneRequest
        t={t}
        text={EP03_REQUEST}
        from={timing.requestFrom}
        cps={timing.requestCps}
        showFrom={EP03_BEATS.work.start}
        tone={BLUE}
      />
      {EP03_LEADS.map((lead, i) => (
        <LeadRow key={lead.name} t={t} i={i} timing={timing} />
      ))}
      <LeadCarriers t={t} timing={timing} />
    </>
  );
}

/** "Outreach.": the five picks, handed to the sales employee, one row each. */
function Picks({ t, timing }: { t: number; timing: Timing }) {
  return (
    <>
      <PhoneTitle text="Outreach." />
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: 104,
          fontSize: 26,
          color: MUTED,
        }}
      >
        Emails to your {EP03_PICKS.length} picks
      </div>
      {EP03_PICKS.map((p, k) => {
        const e = progress(t, pickLandsAt(k, timing) - 0.35, 0.5);
        if (e <= 0) return null;
        const lead = EP03_LEADS[p.row];
        return (
          <div
            key={p.row}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: PICK_ROWS.top + k * PICK_ROWS.step,
              width: W,
              height: PICK_ROWS.h,
              borderRadius: 24,
              background: "#ffffff",
              border: `2px solid ${LINE}`,
              boxSizing: "border-box",
              boxShadow: `0 16px 30px -22px ${tint(AMBER.color, 0.85)}`,
              opacity: Math.min(1, e * 2),
              transform: `translateY(${((1 - easeOutExpo(e)) * 40).toFixed(2)}px) scale(${(0.9 + 0.1 * easeOutBack(e)).toFixed(4)})`,
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 18,
                top: 18,
                width: 64,
                height: 64,
                borderRadius: 32,
                background: BLUE.color,
                color: "#ffffff",
                fontSize: 28,
                fontWeight: 750,
                display: "grid",
                placeItems: "center",
              }}
            >
              {lead.name[0]}
            </span>
            <div
              style={{
                position: "absolute",
                left: 102,
                top: 14,
                fontSize: 32,
                fontWeight: 750,
                letterSpacing: "-0.015em",
                color: INK,
                whiteSpace: "nowrap",
              }}
            >
              {lead.name}
            </div>
            <div
              style={{
                position: "absolute",
                left: 102,
                top: 56,
                fontSize: 23,
                color: MUTED,
              }}
            >
              {lead.why}
            </div>
            <div
              style={{
                position: "absolute",
                right: 18,
                top: 30,
                height: 40,
                padding: "0 16px",
                borderRadius: 999,
                background: tint(AMBER.color, 0.14),
                color: AMBER.deep,
                fontSize: 21,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
              }}
            >
              Email
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Episode 3's work on the phone card: the leads, your picks, then the sales employee's list waiting for your yes. */
export const LeadsPhone: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP03,
}) => (
  <PhoneCard t={t} enterAt={timing.boardIn} glow="hsl(217 60% 35% / 0.4)">
    <PhonePush
      t={t}
      at={PUSH_AT}
      seconds={PUSH_SECONDS}
      first={<Leads t={t} timing={timing} />}
      second={<Picks t={t} timing={timing} />}
    />
    <PinnedButton
      t={t}
      tone={AMBER}
      idle="Approve"
      done="Approved"
      timing={{
        approveIn: timing.approveIn,
        click: Number.POSITIVE_INFINITY,
        doneAt: Number.POSITIVE_INFINITY,
      }}
      pulse
    />
  </PhoneCard>
);

/** The pointer ticking the picks. Frame pixels. */
export const TickCursor: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP03,
}) => {
  if (t < timing.tickCursorFrom) return null;
  const clicks = EP03_PICKS.map((p) => p.at);
  const last = clicks[clicks.length - 1];
  const opacity =
    smoothstep(timing.tickCursorFrom, timing.tickCursorFrom + 0.3, t) *
    (1 - smoothstep(last + 0.5, last + 0.9, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={tickCursorKeys(timing)}
      clicks={clicks}
      opacity={opacity}
    />
  );
};

/** The pointer coming to rest on Approve, unpressed. Frame pixels. */
export const RestCursor: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP03,
}) => {
  if (t < timing.restFrom) return null;
  return (
    <Cursor
      t={t}
      keys={restCursorKeys(timing)}
      clicks={[]}
      opacity={smoothstep(timing.restFrom, timing.restFrom + 0.3, t)}
    />
  );
};
