import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { easeInOutCubic, easeOutExpo, progress, smoothstep } from "../math.ts";
import { bezier } from "../swarm.ts";
import { SCOUT_LOOK, TONES } from "./employees.ts";
import {
  employeeNode,
  SCOUT_CARD,
  SCOUT_TASKS,
  scoutNode,
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

/** Today's plan: Scout sends each employee its task down a trail, then checks the work. */
export const PlanCard: React.FC<{ t: number; timing: PlanTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const scout = local(scoutNode());
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
        Today's plan.
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
        Scout splits the work and hands it out.
      </div>
      <svg
        aria-hidden="true"
        width={SCOUT_CARD.w}
        height={SCOUT_CARD.h}
        style={{ position: "absolute", left: 0, top: 0 }}
      >
        {SCOUT_TASKS.map((task, i) => {
          const draw = easeInOutCubic(
            progress(t, taskStartsAt(i, timing), timing.taskDuration),
          );
          if (draw <= 0) return null;
          const [p0, p1, p2, p3] = taskPath(i).map(local);
          return (
            <path
              key={task.who}
              d={`M${p0.x} ${p0.y} C${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`}
              fill="none"
              stroke={tint(TONES[task.who].color, 0.55)}
              strokeWidth={3}
              strokeDasharray="2 10"
              strokeLinecap="round"
              style={{
                clipPath: `inset(0 ${((1 - draw) * 100).toFixed(2)}% 0 0)`,
              }}
            />
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: scout.x - 56,
          top: scout.y - 56,
          display: "grid",
          justifyItems: "center",
          gap: 10,
          width: 112,
        }}
      >
        <Avatar color={VIOLET} size={112} />
        <div style={{ fontSize: 28, fontWeight: 750 }}>Scout</div>
        <div style={{ fontSize: 20, color: MUTED, whiteSpace: "nowrap" }}>
          Chief of staff
        </div>
      </div>
      {SCOUT_TASKS.map((task, i) => {
        const node = local(employeeNode(i));
        const tone = TONES[task.who];
        const nodeIn = easeOutExpo(
          progress(t, timing.cardIn + 0.3 + i * 0.1, 0.5),
        );
        const u = progress(t, taskStartsAt(i, timing), timing.taskDuration);
        const e = easeInOutCubic(u);
        const [p0, p1, p2, p3] = taskPath(i).map(local);
        const at = bezier(p0, p1, p2, p3, e);
        const landed = t >= taskLandsAt(i, timing);
        const check = smoothstep(
          timing.checkAt + i * 0.12,
          timing.checkAt + i * 0.12 + 0.3,
          t,
        );
        return (
          <div key={task.who}>
            <div
              style={{
                position: "absolute",
                left: node.x - 36,
                top: node.y - 36,
                opacity: nodeIn,
                transform: `scale(${(0.6 + 0.4 * nodeIn).toFixed(4)})`,
              }}
            >
              <Avatar color={tone.color} size={72} />
            </div>
            {u > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: at.x,
                  top: at.y,
                  transform: `translate(-100%, -50%) scale(${(0.45 + 0.55 * e).toFixed(4)})`,
                  transformOrigin: "100% 50%",
                  height: 58,
                  padding: "0 20px",
                  borderRadius: 999,
                  background: "#ffffff",
                  border: `1.5px solid ${landed ? tint(tone.color, 0.5) : LINE}`,
                  boxShadow: `0 16px 30px -18px ${tint(tone.color, 0.8)}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  whiteSpace: "nowrap",
                  fontSize: 23,
                  fontWeight: 650,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    background: tone.color,
                  }}
                />
                {task.text}
                {check > 0 ? (
                  <span
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 15,
                      background: tint(VIOLET, 0.16),
                      display: "grid",
                      placeItems: "center",
                      opacity: check,
                      transform: `scale(${(0.5 + 0.5 * check).toFixed(3)})`,
                    }}
                  >
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
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 52,
          bottom: 40,
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
