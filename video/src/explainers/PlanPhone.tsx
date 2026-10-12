import {
  easeInOutCubic,
  easeOutExpo,
  lerp,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { SCOUT_LOOK, TONES } from "../launch/wide/employees.ts";
import { TEAM_ROWS } from "../launch/wide/how.ts";
import { taskLandsAt, taskStartsAt } from "../launch/wide/scout.ts";
import { EP01, EP01_BEATS, EP01_REQUEST, EP01_TASKS } from "./ep01.ts";
import {
  NOTE_TOP,
  REQUEST_TOP,
  ROWS,
  SCOUT_AT,
  SCOUT_ROW,
  TASK_TEXT_LEFT,
} from "./ep01Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import {
  PhoneAvatar,
  PhoneRequest,
  PhoneTitle,
  PinnedButton,
  tint,
} from "./phoneKit";
import { Tick } from "./RisePostsCard";

const INK = "#17151f";
const LINE = "#ece9f4";
const VIOLET = SCOUT_LOOK.color;
const JOB_OF = Object.fromEntries(TEAM_ROWS.map((row) => [row.who, row.job]));

type Timing = typeof EP01;

/** Scout's row under the title: the avatar the jobs are dealt from. */
function ScoutRow({ t, timing }: { t: number; timing: Timing }) {
  const shown = easeOutExpo(progress(t, timing.cardIn + 0.4, 0.6));
  return (
    <div
      style={{
        position: "absolute",
        left: PHONE_PAD,
        top: SCOUT_ROW.top,
        height: SCOUT_ROW.avatar,
        display: "flex",
        alignItems: "center",
        gap: 18,
        opacity: shown,
      }}
    >
      <PhoneAvatar color={VIOLET} size={SCOUT_ROW.avatar} />
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 30, fontWeight: 750, color: INK }}>Scout</span>
        <span style={{ fontSize: 24, color: SCOUT_LOOK.deep }}>
          Chief of staff
        </span>
      </div>
    </div>
  );
}

/** One job, dealt from Scout into its row: the employee, its job, the task, Assigned then Checked. */
function JobRow({ t, i, timing }: { t: number; i: number; timing: Timing }) {
  const task = EP01_TASKS[i];
  const tone = TONES[task.who];
  const u = progress(t, taskStartsAt(i, timing), timing.taskDuration);
  if (u <= 0) return null;
  const e = easeInOutCubic(u);
  const top = ROWS.top + i * ROWS.step;
  const cx = lerp(SCOUT_AT.x, PHONE_CARD.w / 2, e);
  const cy = lerp(SCOUT_AT.y, top + ROWS.h / 2, e);
  const check = smoothstep(
    timing.checkAt + i * 0.12,
    timing.checkAt + i * 0.12 + 0.3,
    t,
  );
  const landed = t >= taskLandsAt(i, timing);
  const w = PHONE_CARD.w - 2 * PHONE_PAD;
  return (
    <div
      style={{
        position: "absolute",
        left: cx - w / 2,
        top: cy - ROWS.h / 2,
        width: w,
        height: ROWS.h,
        borderRadius: 26,
        background: "#ffffff",
        border: `2px solid ${check > 0 ? tint(VIOLET, 0.35) : LINE}`,
        boxSizing: "border-box",
        boxShadow: `0 18px 34px -20px ${tint(tone.color, 0.85)}`,
        opacity: Math.min(1, u * 4),
        transform: `rotate(${(-7 * (1 - e)).toFixed(3)}deg) scale(${(0.4 + 0.6 * e).toFixed(4)})`,
      }}
    >
      <div style={{ position: "absolute", left: 22, top: 22 }}>
        <PhoneAvatar color={tone.color} size={72} />
      </div>
      <div
        style={{
          position: "absolute",
          left: TASK_TEXT_LEFT - PHONE_PAD,
          top: 16,
          fontSize: 24,
          fontWeight: 650,
          color: tone.deep,
        }}
      >
        {JOB_OF[task.who]}
      </div>
      <div
        style={{
          position: "absolute",
          left: TASK_TEXT_LEFT - PHONE_PAD,
          top: 54,
          fontSize: 32,
          fontWeight: 750,
          letterSpacing: "-0.015em",
          color: INK,
          whiteSpace: "nowrap",
        }}
      >
        {task.text}
      </div>
      {landed ? (
        <div
          style={{
            position: "absolute",
            right: 18,
            top: 12,
            height: 40,
            padding: "0 16px",
            borderRadius: 999,
            background: check > 0 ? tint(VIOLET, 0.14) : tint(tone.color, 0.14),
            color: check > 0 ? SCOUT_LOOK.deep : tone.deep,
            fontSize: 21,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {check > 0 ? <Tick size={18} color={SCOUT_LOOK.deep} /> : null}
          {check > 0 ? "Checked" : "Assigned"}
        </div>
      ) : null}
    </div>
  );
}

/** Episode 1's work on the phone card: your request, Scout's plan dealt as jobs, the checks, your yes. */
export const PlanPhone: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP01,
}) => {
  const note = smoothstep(timing.checkAt, timing.checkAt + 0.4, t);
  return (
    <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(258 60% 40% / 0.45)">
      <PhoneTitle text="This month's plan." />
      <ScoutRow t={t} timing={timing} />
      <PhoneRequest
        t={t}
        text={EP01_REQUEST}
        from={timing.requestFrom}
        cps={timing.requestCps}
        showFrom={EP01_BEATS.work.start}
        tone={SCOUT_LOOK}
        top={REQUEST_TOP}
      />
      {EP01_TASKS.map((task, i) => {
        const slot = easeOutExpo(
          progress(t, timing.cardIn + 0.6 + i * 0.12, 0.5),
        );
        if (slot <= 0 || t >= taskLandsAt(i, timing)) return null;
        return (
          <div
            key={`slot-${task.who}`}
            style={{
              position: "absolute",
              left: PHONE_PAD,
              top: ROWS.top + i * ROWS.step,
              width: PHONE_CARD.w - 2 * PHONE_PAD,
              height: ROWS.h,
              borderRadius: 26,
              border: "2px dashed #e2ddf0",
              background: "#faf9fd",
              boxSizing: "border-box",
              opacity: slot,
            }}
          />
        );
      })}
      {/* Last row first, so a job being dealt passes under the rows already in place. */}
      {[...EP01_TASKS.keys()].reverse().map((i) => (
        <JobRow key={EP01_TASKS[i].who} t={t} i={i} timing={timing} />
      ))}
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: NOTE_TOP,
          height: 30,
          fontSize: 24,
          fontWeight: 600,
          color: SCOUT_LOOK.deep,
          opacity: note,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{ width: 12, height: 12, borderRadius: 6, background: VIOLET }}
        />
        Scout checks every piece before it reaches you.
      </div>
      <PinnedButton
        t={t}
        tone={SCOUT_LOOK}
        idle="Approve plan"
        done="Plan approved"
        timing={{
          approveIn: timing.approveIn,
          click: timing.click,
          doneAt: timing.approvedAt,
        }}
      />
    </PhoneCard>
  );
};
