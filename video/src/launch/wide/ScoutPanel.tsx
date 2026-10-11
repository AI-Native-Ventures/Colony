import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { easeInOutCubic, easeOutExpo, progress, smoothstep } from "../math.ts";
import { bezier } from "../swarm.ts";
import { SCOUT_LOOK, TONES } from "./employees.ts";
import { TEAM_ROWS } from "./how.ts";
import {
  employeeNode,
  SCOUT_CARD,
  SCOUT_TASKS,
  type ScoutTask,
  scoutNode,
  TASK_CARD_W,
  type TaskTiming,
  taskLandsAt,
  taskPath,
  taskStartsAt,
} from "./scout.ts";

export type PlanTiming = TaskTiming & { cardIn: number; checkAt: number };

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const VIOLET = SCOUT_LOOK.color;

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

function local(p: { x: number; y: number }) {
  return { x: p.x - SCOUT_CARD.x, y: p.y - SCOUT_CARD.y };
}

function Avatar({ color, size }: { color: string; size: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        background: color,
        display: "grid",
        placeItems: "center",
        boxShadow: `0 14px 30px -14px ${tint(color, 0.8)}`,
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

/** Each employee's job, as the plan card labels its task. */
const JOB_OF = Object.fromEntries(TEAM_ROWS.map((row) => [row.who, row.job]));

/** Today's plan: Scout deals each employee its task, then checks the work. */
export const PlanCard: React.FC<{
  t: number;
  timing: PlanTiming;
  /** Defaults are the launch film's plan for the plumber. */
  tasks?: readonly ScoutTask[];
  title?: string;
  /** Empty to leave the line free for the owner's request. */
  subtitle?: string;
}> = ({
  t,
  timing,
  tasks = SCOUT_TASKS,
  title = "Today's plan.",
  subtitle = "Scout splits the work and hands it out.",
}) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const badge = local(scoutNode());
  const checks = smoothstep(timing.checkAt, timing.checkAt + 0.4, t);
  return (
    <div
      style={{
        position: "absolute",
        left: SCOUT_CARD.x,
        top: SCOUT_CARD.y,
        width: SCOUT_CARD.w,
        height: SCOUT_CARD.h,
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
        {title}
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
        {subtitle}
      </div>
      <div
        style={{
          position: "absolute",
          left: badge.x - 140,
          top: badge.y - 38,
          width: 280,
          height: 76,
          borderRadius: 999,
          background: tint(VIOLET, 0.1),
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 14px",
          boxSizing: "border-box",
        }}
      >
        <Avatar color={VIOLET} size={52} />
        <div style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 24, fontWeight: 750 }}>Scout</span>
          <span style={{ fontSize: 20, color: SCOUT_LOOK.deep }}>
            Chief of staff
          </span>
        </div>
      </div>
      {/* Drawn last row first, so a card being dealt passes under the rows already in place. */}
      {[...tasks.keys()].reverse().map((i) => {
        const task = tasks[i];
        const node = local(employeeNode(i));
        const tone = TONES[task.who];
        const lands = taskLandsAt(i, timing);
        const nodeIn = easeOutExpo(progress(t, lands - 0.25, 0.5));
        const u = progress(t, taskStartsAt(i, timing), timing.taskDuration);
        const e = easeInOutCubic(u);
        const [p0, p1, p2, p3] = taskPath(i).map(local);
        const at = bezier(p0, p1, p2, p3, e);
        const check = smoothstep(
          timing.checkAt + i * 0.12,
          timing.checkAt + i * 0.12 + 0.3,
          t,
        );
        return (
          <div key={task.who}>
            {nodeIn > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: node.x - 34,
                  top: node.y - 34,
                  opacity: nodeIn,
                  transform: `scale(${(0.6 + 0.4 * nodeIn).toFixed(4)})`,
                }}
              >
                <Avatar color={tone.color} size={68} />
              </div>
            ) : null}
            {u > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: at.x - TASK_CARD_W / 2,
                  top: at.y - 48,
                  width: TASK_CARD_W,
                  height: 96,
                  borderRadius: 22,
                  background: "#ffffff",
                  border: `1.5px solid ${check > 0 ? tint(VIOLET, 0.35) : LINE}`,
                  boxShadow: `0 18px 34px -20px ${tint(tone.color, 0.85)}`,
                  opacity: Math.min(1, u * 4),
                  transform: `rotate(${(-7 * (1 - e)).toFixed(3)}deg) scale(${(0.5 + 0.5 * e).toFixed(4)})`,
                  transformOrigin: "50% 50%",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 26,
                    top: 12,
                    fontSize: 20,
                    fontWeight: 600,
                    color: tone.deep,
                  }}
                >
                  {JOB_OF[task.who]}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 26,
                    top: 42,
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: "-0.015em",
                    whiteSpace: "nowrap",
                  }}
                >
                  {task.text}
                </div>
                <div
                  style={{
                    position: "absolute",
                    right: 20,
                    top: 26,
                    height: 44,
                    padding: "0 16px",
                    borderRadius: 999,
                    background:
                      check > 0 ? tint(VIOLET, 0.14) : tint(tone.color, 0.14),
                    color: check > 0 ? SCOUT_LOOK.deep : tone.deep,
                    fontSize: 21,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {check > 0 ? (
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M5 12.5l4.2 4.2L19 7"
                        fill="none"
                        stroke={SCOUT_LOOK.deep}
                        strokeWidth={3.2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                  {check > 0 ? "Checked" : "Assigned"}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 52,
          bottom: 36,
          fontSize: 22,
          fontWeight: 600,
          color: SCOUT_LOOK.deep,
          opacity: checks,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{ width: 10, height: 10, borderRadius: 5, background: VIOLET }}
        />
        Scout checks every piece before it reaches you.
      </div>
    </div>
  );
};
