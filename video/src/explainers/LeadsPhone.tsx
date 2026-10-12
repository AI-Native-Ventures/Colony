import { Cursor } from "../launch/app/Cursor";
import {
  easeOutExpo,
  lerpAngle,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { easeOutBack } from "../launch/wide/EmployeeHero";
import {
  type BoardTiming,
  carryStart,
  foundCount,
  type Lead,
  landsAt,
} from "../launch/wide/beat.ts";
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

/** The episode's timing; the film's leads beat has only the board's part (no reasons, request or hand-over). */
type Timing = BoardTiming & {
  boardIn: number;
  reasonsAt?: number;
  reasonsEvery?: number;
  requestFrom?: number;
  requestCps?: number;
};

/** The leads on the card: which, a line under the title, where the rows start, the owner's request, and the picks (with the hand-over to sales). */
export type LeadsSetup = {
  leads: readonly Lead[];
  subline?: string;
  rowsTop: number;
  request?: { text: string; showFrom: number };
  picks?: readonly { row: number; at: number }[];
};

const EP03_SETUP: LeadsSetup = {
  leads: EP03_LEADS,
  rowsTop: LEAD_ROWS.top,
  request: { text: EP03_REQUEST, showFrom: EP03_BEATS.work.start },
  picks: EP03_PICKS,
};

/** One lead's row: its name once its ant lands, why it fits (or where it is, with its score), the tick box, ticked if picked. */
function LeadRow({
  t,
  i,
  timing,
  setup,
}: {
  t: number;
  i: number;
  timing: Timing;
  setup: LeadsSetup;
}) {
  const lead = setup.leads[i];
  const top = setup.rowsTop + i * LEAD_ROWS.step;
  const name = easeOutExpo(progress(t, landsAt(i, timing) - 0.05, 0.35));
  const reasons = timing.reasonsAt !== undefined;
  const why = reasons
    ? easeOutExpo(
        progress(
          t,
          (timing.reasonsAt ?? 0) + i * (timing.reasonsEvery ?? 0),
          0.4,
        ),
      )
    : name;
  const pick = setup.picks?.find((p) => p.row === i);
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
          {reasons ? lead.why : lead.area}
        </div>
      ) : null}
      {!reasons && name > 0 ? (
        <div
          style={{
            position: "absolute",
            right: PHONE_PAD - 20,
            top: (LEAD_ROWS.h - 44) / 2,
            height: 44,
            minWidth: 64,
            padding: "0 14px",
            borderRadius: 999,
            boxSizing: "border-box",
            background: tint(BLUE.color, 0.12),
            color: BLUE.deep,
            fontSize: 24,
            fontWeight: 750,
            display: "grid",
            placeItems: "center",
            fontVariantNumeric: "tabular-nums",
            opacity: name,
          }}
        >
          {lead.score}
        </div>
      ) : null}
      {setup.picks && why > 0 ? (
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
function LeadCarriers({
  t,
  timing,
  setup,
}: {
  t: number;
  timing: Timing;
  setup: LeadsSetup;
}) {
  return (
    <>
      {setup.leads.map((lead, i) => {
        const start = carryStart(i, timing);
        if (t < start) return null;
        const s = walkState(
          leadCarryPath(i, setup.rowsTop),
          t,
          start,
          timing.carryDuration,
        );
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
function Leads({
  t,
  timing,
  setup,
}: {
  t: number;
  timing: Timing;
  setup: LeadsSetup;
}) {
  const found = foundCount(t, timing, setup.leads.length);
  const shown = smoothstep(timing.carryFrom, timing.carryFrom + 0.3, t);
  const rushEnd = timing.countRushFrom + timing.countRush;
  const bump = t >= rushEnd ? 1 - progress(t, rushEnd, 0.4) : 0;
  return (
    <>
      <PhoneTitle text="Leads." />
      {setup.subline ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top: 108,
            fontSize: 26,
            color: MUTED,
            whiteSpace: "nowrap",
          }}
        >
          {setup.subline}
        </div>
      ) : null}
      <PhonePill
        label={`${found} found`}
        tone={BLUE}
        opacity={shown}
        bump={bump}
      />
      {setup.request &&
      timing.requestFrom !== undefined &&
      timing.requestCps !== undefined ? (
        <PhoneRequest
          t={t}
          text={setup.request.text}
          from={timing.requestFrom}
          cps={timing.requestCps}
          showFrom={setup.request.showFrom}
          tone={BLUE}
        />
      ) : null}
      {setup.leads.map((lead, i) => (
        <LeadRow key={lead.name} t={t} i={i} timing={timing} setup={setup} />
      ))}
      <LeadCarriers t={t} timing={timing} setup={setup} />
    </>
  );
}

/** "Outreach.": the five picks, handed to the sales employee, one row each. */
function Picks({ t, timing }: { t: number; timing: typeof EP03 }) {
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
export const LeadsPhone: React.FC<{ t: number }> = ({ t }) => (
  <PhoneCard t={t} enterAt={EP03.boardIn} glow="hsl(217 60% 35% / 0.4)">
    <PhonePush
      t={t}
      at={PUSH_AT}
      seconds={PUSH_SECONDS}
      first={<Leads t={t} timing={EP03} setup={EP03_SETUP} />}
      second={<Picks t={t} timing={EP03} />}
    />
    <PinnedButton
      t={t}
      tone={AMBER}
      idle="Approve"
      done="Approved"
      timing={{
        approveIn: EP03.approveIn,
        click: Number.POSITIVE_INFINITY,
        doneAt: Number.POSITIVE_INFINITY,
      }}
      pulse
    />
  </PhoneCard>
);

/** The leads alone on the phone card, for the film's blue beat: carried in, counted to twenty. */
export const LeadsOnlyPhone: React.FC<{
  t: number;
  timing: Timing;
  setup: LeadsSetup;
}> = ({ t, timing, setup }) => (
  <PhoneCard t={t} enterAt={timing.boardIn} glow="hsl(217 60% 35% / 0.4)">
    <Leads t={t} timing={timing} setup={setup} />
  </PhoneCard>
);

/** The pointer ticking the picks. Frame pixels. */
export const TickCursor: React.FC<{ t: number; timing?: typeof EP03 }> = ({
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
export const RestCursor: React.FC<{ t: number; timing?: typeof EP03 }> = ({
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
