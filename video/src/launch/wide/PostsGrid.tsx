import { INTER } from "../fonts";
import { easeOutExpo, lerp, lerpAngle, progress, smoothstep } from "../math.ts";
import { TONES } from "./employees.ts";
import { PostArt } from "./BrightPosts";
import {
  POST_SIZE,
  POSTS,
  POSTS_CARD,
  type PostTiming,
  postCarryPath,
  postCarryStart,
  postLandsAt,
  postsLanded,
  postSlot,
} from "./posts.ts";
import { walkState } from "./walk.ts";
import { WorkerAnt } from "./WorkerAnt";

export type PostsTiming = PostTiming & { gridIn: number; readyAt: number };

const PINK = TONES.pink;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";

/** How small a post rides on its ant's back. */
const CARRIED = 0.27;
const CARRY_LIFT = 74;

function tint(alpha: number): string {
  return PINK.color.replace(")", ` / ${alpha})`);
}

/** Posts card: three example posts carried in by pink ants, ready for Instagram. */
export const PostsGrid: React.FC<{ t: number; timing: PostsTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.gridIn, 0.9));
  if (enter <= 0) return null;
  const count = postsLanded(t, timing);
  const bump = Math.max(
    0,
    ...POSTS.map((_, i) =>
      t >= postLandsAt(i, timing)
        ? 1 - progress(t, postLandsAt(i, timing), 0.28)
        : 0,
    ),
    t >= timing.readyAt ? 1 - progress(t, timing.readyAt, 0.4) : 0,
  );
  const done = smoothstep(timing.readyAt, timing.readyAt + 0.3, t);
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
      <div
        style={{
          position: "absolute",
          left: 52,
          top: 116,
          fontSize: 24,
          color: MUTED,
        }}
      >
        Pictures and words for Instagram, made for your business.
      </div>
      <div
        style={{
          position: "absolute",
          right: 48,
          top: 54,
          height: 64,
          padding: "0 28px",
          borderRadius: 999,
          background: tint(0.12 + 0.06 * done),
          color: PINK.deep,
          fontSize: 32,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          fontVariantNumeric: "tabular-nums",
          transform: `scale(${(1 + 0.08 * bump).toFixed(4)})`,
        }}
      >
        {count} ready
      </div>
      {POSTS.map((post, i) => {
        const slot = postSlot(i);
        const left = slot.x - POSTS_CARD.x;
        const top = slot.y - POSTS_CARD.y;
        const placed = t >= postLandsAt(i, timing) + 0.45;
        const caption = easeOutExpo(
          progress(t, postLandsAt(i, timing) + 0.2, 0.45),
        );
        return (
          <div key={post.id}>
            {placed ? null : (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: POST_SIZE,
                  height: POST_SIZE,
                  borderRadius: 24,
                  background: "#faf9fd",
                  border: "2px dashed #e2ddf0",
                  boxSizing: "border-box",
                }}
              />
            )}
            {placed ? (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: POST_SIZE,
                  height: POST_SIZE,
                  boxShadow: "0 24px 40px -24px hsl(222 50% 20% / 0.45)",
                  borderRadius: 24,
                }}
              >
                <PostArt id={post.id} />
              </div>
            ) : null}
            <div
              style={{
                position: "absolute",
                left: left + 64,
                top: top + POST_SIZE + 30,
                fontSize: 22,
                fontWeight: 600,
                color: MUTED,
                opacity: caption,
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
export const PostCarriers: React.FC<{ t: number; timing: PostsTiming }> = ({
  t,
  timing,
}) => (
  <>
    {POSTS.map((post, i) => {
      const start = postCarryStart(i, timing);
      if (t < start) return null;
      const s = walkState(postCarryPath(i), t, start, timing.carryDuration);
      const land = postLandsAt(i, timing);
      const settle = smoothstep(land, land + 0.35, t);
      const angle = lerpAngle(s.angle, 0, settle);
      const fly = easeOutExpo(progress(t, land, 0.45));
      const slot = postSlot(i);
      const sway = 2.2 * Math.sin(s.phase * Math.PI * 2) * s.amp;
      const carriedX = s.x;
      const carriedY = s.y - CARRY_LIFT;
      const cx = lerp(carriedX, slot.x + POST_SIZE / 2, fly);
      const cy = lerp(carriedY, slot.y + POST_SIZE / 2, fly);
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
                borderRadius: 24,
                boxShadow: "0 18px 30px -18px hsl(222 50% 20% / 0.6)",
                transform: `rotate(${(sway * (1 - fly)).toFixed(2)}deg) scale(${scale.toFixed(4)})`,
              }}
            >
              <PostArt id={post.id} />
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
