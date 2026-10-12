import { PhoneCard } from "../../explainers/PhoneCard";
import { PHONE_PAD } from "../../explainers/phone.ts";
import { PhonePill, PhoneTitle } from "../../explainers/phoneKit";
import { easeOutExpo, lerp, progress, smoothstep } from "../math.ts";
import { PostArt } from "../wide/BrightPosts";
import { AntBadge } from "../wide/DayPanel";
import { TONES } from "../wide/employees.ts";
import type { PostsTiming } from "../wide/PostsGrid";
import {
  POST_SIZE,
  POSTS,
  postCarryStart,
  postLandsAt,
  postsLanded,
} from "../wide/posts.ts";
import { walkState } from "../wide/walk.ts";
import { WorkerAnt } from "../wide/WorkerAnt";
import {
  FILM_POST_ROWS as R,
  filmPostCarryPath,
  filmPostTop,
} from "./filmPages.ts";

const PINK = TONES.pink;
const INK = "#17151f";
const MUTED = "#6a6780";
/** How small a post rides on its ant's back, and how high. */
const CARRIED = 0.27;
const CARRY_LIFT = 74;
/** A post's art is drawn at the wide film's size; a row shows it at its own. */
const ROW_SCALE = R.post / POST_SIZE;
const POST_SHADOW = "0 30px 50px -30px hsl(222 50% 20% / 0.5)";

/** Top right: "Making", then how many are ready, ticked once all three are. */
function Status({ t, timing }: { t: number; timing: PostsTiming }) {
  const landed = postsLanded(t, timing);
  const bump = Math.max(
    0,
    ...POSTS.map((_, i) =>
      t >= postLandsAt(i, timing)
        ? 1 - progress(t, postLandsAt(i, timing), 0.28)
        : 0,
    ),
    t >= timing.readyAt ? 1 - progress(t, timing.readyAt, 0.4) : 0,
  );
  return (
    <PhonePill
      label={landed === 0 ? "Making" : `${landed} ready`}
      tone={PINK}
      opacity={smoothstep(timing.carryFrom, timing.carryFrom + 0.3, t)}
      done={t >= timing.readyAt}
      bump={bump}
    />
  );
}

/** One post's row: its empty slot until the post is down, then the post, its time and where it goes. */
function PostRow({
  t,
  i,
  timing,
}: {
  t: number;
  i: number;
  timing: PostsTiming;
}) {
  const post = POSTS[i];
  const top = filmPostTop(i);
  const land = postLandsAt(i, timing);
  const text = easeOutExpo(progress(t, land + 0.2, 0.45));
  return (
    <>
      {t >= land + 0.45 ? (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top,
            width: R.post,
            height: R.post,
            borderRadius: 30,
            overflow: "hidden",
            boxShadow: POST_SHADOW,
          }}
        >
          <div
            style={{
              width: POST_SIZE,
              height: POST_SIZE,
              transform: `scale(${ROW_SCALE.toFixed(5)})`,
              transformOrigin: "0 0",
            }}
          >
            <PostArt id={post.id} />
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: PHONE_PAD,
            top,
            width: R.post,
            height: R.post,
            borderRadius: 30,
            background: "#faf9fd",
            border: "2px dashed #e2ddf0",
            boxSizing: "border-box",
          }}
        />
      )}
      {text > 0 ? (
        <div
          style={{
            position: "absolute",
            left: R.textLeft,
            top: top + 72,
            opacity: text,
            transform: `translateY(${((1 - text) * 14).toFixed(2)}px)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: 44,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: INK,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            <AntBadge color={PINK.color} size={40} />
            {post.when}
          </div>
          <div
            style={{ marginTop: 8, marginLeft: 52, fontSize: 26, color: MUTED }}
          >
            Instagram
          </div>
        </div>
      ) : null}
    </>
  );
}

/** A post leaving its ant's back for its row. Card pixels. */
function FlyingPost({
  t,
  i,
  timing,
}: {
  t: number;
  i: number;
  timing: PostsTiming;
}) {
  const land = postLandsAt(i, timing);
  const fly = easeOutExpo(progress(t, land, 0.45));
  if (t < land || fly >= 1) return null;
  const path = filmPostCarryPath(i);
  const from = path[path.length - 1];
  const x = lerp(from.x, PHONE_PAD + R.post / 2, fly);
  const y = lerp(from.y - CARRY_LIFT, filmPostTop(i) + R.post / 2, fly);
  return (
    <div
      style={{
        position: "absolute",
        left: x - POST_SIZE / 2,
        top: y - POST_SIZE / 2,
        width: POST_SIZE,
        height: POST_SIZE,
        borderRadius: 24,
        overflow: "hidden",
        boxShadow: POST_SHADOW,
        transform: `scale(${lerp(CARRIED, ROW_SCALE, fly).toFixed(4)})`,
      }}
    >
      <PostArt id={POSTS[i].id} />
    </div>
  );
}

/** Pink ants carrying each post in on their backs from the card's right edge; they fade once it is down. Card pixels. */
function Carriers({ t, timing }: { t: number; timing: PostsTiming }) {
  return (
    <>
      {POSTS.map((post, i) => {
        const start = postCarryStart(i, timing);
        if (t < start) return null;
        const land = postLandsAt(i, timing);
        const gone = smoothstep(land + 0.15, land + 0.55, t);
        if (gone >= 1) return null;
        const s = walkState(
          filmPostCarryPath(i),
          t,
          start,
          timing.carryDuration,
        );
        const sway = 2.2 * Math.sin(s.phase * Math.PI * 2) * s.amp;
        return (
          <div key={post.id} style={{ opacity: 1 - gone }}>
            {t < land ? (
              <div
                style={{
                  position: "absolute",
                  left: s.x - POST_SIZE / 2,
                  top: s.y - CARRY_LIFT - POST_SIZE / 2,
                  width: POST_SIZE,
                  height: POST_SIZE,
                  borderRadius: 24,
                  overflow: "hidden",
                  boxShadow: POST_SHADOW,
                  transform: `rotate(${sway.toFixed(2)}deg) scale(${CARRIED})`,
                }}
              >
                <PostArt id={post.id} />
              </div>
            ) : null}
            <WorkerAnt
              x={s.x}
              y={s.y}
              angle={s.angle}
              size={56}
              color={PINK.color}
              phase={s.phase}
              amp={s.amp}
            />
          </div>
        );
      })}
    </>
  );
}

/** The film's posts on the phone card: three posts carried in, a row each with its time, then ready. */
export const PostsPhone: React.FC<{ t: number; timing: PostsTiming }> = ({
  t,
  timing,
}) => (
  <PhoneCard t={t} enterAt={timing.gridIn} glow="hsl(330 50% 35% / 0.4)">
    <PhoneTitle text="Posts." />
    <Status t={t} timing={timing} />
    {POSTS.map((post, i) => (
      <PostRow key={post.id} t={t} i={i} timing={timing} />
    ))}
    {POSTS.map((post, i) => (
      <FlyingPost key={post.id} t={t} i={i} timing={timing} />
    ))}
    <Carriers t={t} timing={timing} />
  </PhoneCard>
);
