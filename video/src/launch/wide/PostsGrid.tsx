import { INTER } from "../fonts";
import { easeOutExpo, lerp, lerpAngle, progress, smoothstep } from "../math.ts";
import { TONES } from "./employees.ts";
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

/** Bright Plumbing's own look: the posts are theirs, not Colony's. */
const NAVY = "#13284a";
const AQUA = "hsl(190 85% 52%)";
const SUN = "hsl(45 95% 55%)";

/** How small a post rides on its ant's back. */
const CARRIED = 0.27;
const CARRY_LIFT = 74;

function tint(alpha: number): string {
  return PINK.color.replace(")", ` / ${alpha})`);
}

function Drop({ size, color }: { size: number; color: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size * 1.3}
      viewBox="0 0 40 52"
    >
      <path
        d="M20 2 C20 2 4 22 4 33 a16 16 0 0 0 32 0 C36 22 20 2 20 2 Z"
        fill={color}
      />
      <path
        d="M12 34 a8 8 0 0 0 8 8"
        fill="none"
        stroke="#ffffff"
        strokeOpacity={0.7}
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  );
}

function Star({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"
        fill={SUN}
      />
    </svg>
  );
}

function Thermo() {
  return (
    <svg aria-hidden="true" width={44} height={78} viewBox="0 0 44 78">
      <rect x={14} y={4} width={16} height={50} rx={8} fill={NAVY} />
      <circle cx={22} cy={60} r={14} fill={NAVY} />
      <rect x={19} y={22} width={6} height={34} rx={3} fill={SUN} />
      <circle cx={22} cy={60} r={8} fill={SUN} />
    </svg>
  );
}

const square: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  borderRadius: 24,
  overflow: "hidden",
  fontFamily: INTER,
};

/** One example Instagram post for Bright Plumbing, drawn in code at full size. */
export const PostArt: React.FC<{ id: string }> = ({ id }) => {
  if (id === "leak") {
    return (
      <div
        style={{
          ...square,
          background: `linear-gradient(160deg, ${NAVY}, #1f4580)`,
        }}
      >
        <div style={{ position: "absolute", left: 26, top: 24 }}>
          <Drop size={44} color={AQUA} />
        </div>
        <div
          style={{
            position: "absolute",
            left: 26,
            top: 104,
            fontSize: 48,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.02,
            color: AQUA,
          }}
        >
          Leak?
          <div style={{ color: "#ffffff", fontSize: 40 }}>Fixed today.</div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 26,
            bottom: 22,
            fontSize: 20,
            fontWeight: 600,
            color: "rgba(255,255,255,0.72)",
          }}
        >
          Same day in Sandton
        </div>
      </div>
    );
  }
  if (id === "geyser") {
    return (
      <div
        style={{
          ...square,
          background: `linear-gradient(160deg, hsl(190 85% 60%), hsl(200 80% 50%))`,
        }}
      >
        <div style={{ position: "absolute", right: 24, bottom: 20 }}>
          <Thermo />
        </div>
        <div
          style={{
            position: "absolute",
            left: 26,
            top: 28,
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            color: NAVY,
          }}
        >
          Geyser
          <br />
          check before
          <br />
          winter.
        </div>
        <div
          style={{
            position: "absolute",
            left: 26,
            bottom: 24,
            height: 46,
            padding: "0 18px",
            borderRadius: 999,
            background: NAVY,
            color: "#ffffff",
            fontSize: 24,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
          }}
        >
          R450
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        ...square,
        background: "#ffffff",
        boxShadow: `inset 0 0 0 3px hsl(190 70% 88%)`,
      }}
    >
      <div style={{ position: "absolute", left: 24, top: 26, display: "flex" }}>
        {[0, 1, 2, 3, 4].map((k) => (
          <Star key={k} size={30} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 26,
          right: 22,
          top: 78,
          fontSize: 31,
          fontWeight: 750,
          letterSpacing: "-0.02em",
          lineHeight: 1.12,
          color: NAVY,
        }}
      >
        "Fast, clean and so friendly."
      </div>
      <div
        style={{
          position: "absolute",
          left: 26,
          bottom: 24,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 20,
          fontWeight: 600,
          color: MUTED,
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 15,
            background: AQUA,
            color: "#ffffff",
            fontSize: 16,
            fontWeight: 800,
            display: "grid",
            placeItems: "center",
          }}
        >
          L
        </span>
        Lerato, Rosebank
      </div>
    </div>
  );
};

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
