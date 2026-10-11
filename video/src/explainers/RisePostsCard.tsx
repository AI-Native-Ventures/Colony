import { Cursor } from "../launch/app/Cursor";
import { INTER } from "../launch/fonts";
import {
  easeOutExpo,
  lerp,
  lerpAngle,
  progress,
  smoothstep,
} from "../launch/math.ts";
import { TONES } from "../launch/wide/employees.ts";
import {
  POST_SIZE,
  POSTS_CARD,
  postCarryPath,
  postCarryStart,
  postLandsAt,
  postSlot,
} from "../launch/wide/posts.ts";
import { walkState } from "../launch/wide/walk.ts";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import { EP05, EP05_REQUEST } from "./ep05.ts";
import { APPROVE_BUTTON, approveCursorKeys } from "./ep05Card.ts";
import { RISE_POSTS } from "./rise.ts";
import { RisePostArt } from "./RisePosts";

const PINK = TONES.pink;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
/** How small a post rides on its ant's back. */
const CARRIED = 0.27;
const CARRY_LIFT = 74;

type EpTiming = typeof EP05;

function tint(alpha: number): string {
  return PINK.color.replace(")", ` / ${alpha})`);
}

const landsAt = (i: number, timing: EpTiming) => postLandsAt(i, timing);

function Tick({ size, color }: { size: number; color: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M5 12.5l4.2 4.2L19 7"
        fill="none"
        stroke={color}
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Top right of the card: "Making", then "3 ready", then the Approve button, then "3 posts scheduled". */
function StatusPill({ t, timing }: { t: number; timing: EpTiming }) {
  const landed = RISE_POSTS.filter((_, i) => t >= landsAt(i, timing)).length;
  const button = smoothstep(timing.approveIn, timing.approveIn + 0.35, t);
  const pressed = t >= timing.click && t < timing.click + 0.14 ? 0.96 : 1;
  const done = t >= timing.scheduledAt;
  const bump = t >= timing.readyAt ? 1 - progress(t, timing.readyAt, 0.4) : 0;
  const label = done
    ? "3 posts scheduled"
    : button > 0.5
      ? "Approve and schedule"
      : t >= timing.readyAt
        ? "3 ready"
        : landed === 0
          ? "Making"
          : `${landed} of 3 ready`;
  const shown = smoothstep(timing.carryFrom, timing.carryFrom + 0.3, t);
  const filled = button > 0.5 && !done;
  if (shown <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        opacity: shown,
        right: 48,
        top: APPROVE_BUTTON.y - POSTS_CARD.y,
        height: APPROVE_BUTTON.h,
        minWidth: filled ? APPROVE_BUTTON.w : undefined,
        padding: "0 28px",
        boxSizing: "border-box",
        borderRadius: 999,
        background: filled ? PINK.color : tint(done ? 0.18 : 0.12),
        color: filled ? "#ffffff" : PINK.deep,
        boxShadow: filled ? `0 18px 30px -16px ${tint(0.9)}` : undefined,
        fontSize: 28,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        fontVariantNumeric: "tabular-nums",
        transform: `scale(${((1 + 0.08 * bump) * pressed).toFixed(4)})`,
        transformOrigin: "right center",
      }}
    >
      {done ? <Tick size={26} color={PINK.deep} /> : null}
      {label}
    </div>
  );
}

/** The posts card: what you asked for, typed; three posts carried in; their times; your yes. */
export const RisePostsCard: React.FC<{ t: number; timing?: EpTiming }> = ({
  t,
  timing = EP05,
}) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const typed = Math.max(
    0,
    Math.min(
      EP05_REQUEST.length,
      Math.floor((t - timing.requestFrom) * timing.requestCps),
    ),
  );
  const typing = typed > 0 && typed < EP05_REQUEST.length;
  const caretOn =
    typing || (t < timing.requestFrom + 0.1 && t > timing.cardIn + 0.4);
  return (
    <div
      style={{
        position: "absolute",
        left: POSTS_CARD.x,
        top: POSTS_CARD.y,
        width: POSTS_CARD.w,
        height: POSTS_CARD.h,
        borderRadius: 32,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxShadow: "0 50px 100px -50px hsl(330 50% 35% / 0.4)",
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
        Posts.
      </div>
      <StatusPill t={t} timing={timing} />
      <div
        style={{
          position: "absolute",
          left: 52,
          right: 48,
          top: 134,
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        <span
          style={{
            flex: "none",
            height: 40,
            padding: "0 16px",
            borderRadius: 999,
            background: "#f4f3f8",
            color: MUTED,
            fontSize: 20,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
          }}
        >
          You asked
        </span>
        <span style={{ whiteSpace: "nowrap" }}>
          {EP05_REQUEST.slice(0, typed)}
          {caretOn ? (
            <span
              style={{
                display: "inline-block",
                width: 3,
                height: 32,
                marginLeft: 2,
                verticalAlign: "-5px",
                background: PINK.color,
              }}
            />
          ) : null}
        </span>
      </div>
      {RISE_POSTS.map((post, i) => {
        const slot = postSlot(i);
        const left = slot.x - POSTS_CARD.x;
        const top = slot.y - POSTS_CARD.y;
        const placed = t >= landsAt(i, timing) + 0.45;
        const time = easeOutExpo(progress(t, timing.timesAt + i * 0.14, 0.5));
        const tick = easeOutExpo(
          progress(t, timing.scheduledAt + i * 0.08, 0.4),
        );
        return (
          <div key={post.id}>
            {placed ? (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: POST_SIZE,
                  height: POST_SIZE,
                  boxShadow: "0 24px 40px -24px hsl(25 50% 20% / 0.45)",
                  borderRadius: 22,
                }}
              >
                <RisePostArt id={post.id} />
              </div>
            ) : (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: POST_SIZE,
                  height: POST_SIZE,
                  borderRadius: 22,
                  background: "#faf9fd",
                  border: "2px dashed #e2ddf0",
                  boxSizing: "border-box",
                }}
              />
            )}
            {tick > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: left + POST_SIZE - 26,
                  top: top - 14,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  background: PINK.color,
                  border: "3px solid #ffffff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transform: `scale(${tick.toFixed(4)})`,
                }}
              >
                <Tick size={22} color="#ffffff" />
              </div>
            ) : null}
            <div
              style={{
                position: "absolute",
                left: left + 64,
                top: top + POST_SIZE + 30,
                fontSize: 24,
                fontWeight: 700,
                color: INK,
                opacity: time,
                transform: `translateY(${((1 - time) * 14).toFixed(2)}px)`,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {post.when}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Pink ants carrying each post in on their backs; at the slot the post flies up into place. */
export const RisePostCarriers: React.FC<{ t: number; timing?: EpTiming }> = ({
  t,
  timing = EP05,
}) => (
  <>
    {RISE_POSTS.map((post, i) => {
      const start = postCarryStart(i, timing);
      if (t < start) return null;
      const s = walkState(postCarryPath(i), t, start, timing.carryDuration);
      const land = landsAt(i, timing);
      const settle = smoothstep(land, land + 0.35, t);
      const angle = lerpAngle(s.angle, 0, settle);
      const fly = easeOutExpo(progress(t, land, 0.45));
      const slot = postSlot(i);
      const sway = 2.2 * Math.sin(s.phase * Math.PI * 2) * s.amp;
      const cx = lerp(s.x, slot.x + POST_SIZE / 2, fly);
      const cy = lerp(s.y - CARRY_LIFT, slot.y + POST_SIZE / 2, fly);
      const scale = lerp(CARRIED, 1, fly);
      return (
        <div key={post.id}>
          {fly < 1 ? (
            <div
              style={{
                position: "absolute",
                left: cx - POST_SIZE / 2,
                top: cy - POST_SIZE / 2,
                width: POST_SIZE,
                height: POST_SIZE,
                borderRadius: 22,
                boxShadow: "0 18px 30px -18px hsl(25 50% 20% / 0.6)",
                transform: `rotate(${(sway * (1 - fly)).toFixed(2)}deg) scale(${scale.toFixed(4)})`,
              }}
            >
              <RisePostArt id={post.id} />
            </div>
          ) : null}
          <WorkerAnt
            x={s.x}
            y={s.y}
            angle={angle}
            size={60}
            color={PINK.color}
            phase={s.phase}
            amp={s.amp}
          />
        </div>
      );
    })}
  </>
);

/** The owner's pointer, onto Approve at the yes beat. */
export const ApproveCursor: React.FC<{ t: number; timing?: EpTiming }> = ({
  t,
  timing = EP05,
}) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.click + 0.7, timing.click + 1.1, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={approveCursorKeys(timing)}
      clicks={[timing.click]}
      opacity={opacity}
    />
  );
};
