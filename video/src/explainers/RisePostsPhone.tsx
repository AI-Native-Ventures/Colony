import { Cursor } from "../launch/app/Cursor";
import { easeOutExpo, lerp, progress, smoothstep } from "../launch/math.ts";
import { AntBadge } from "../launch/wide/DayPanel";
import { TONES } from "../launch/wide/employees.ts";
import {
  POST_SIZE,
  postCarryStart,
  postLandsAt,
} from "../launch/wide/posts.ts";
import { walkState } from "../launch/wide/walk.ts";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import { EP05, EP05_REQUEST } from "./ep05.ts";
import {
  APPROVE,
  DROP,
  FEED,
  FEED_LEFT,
  phoneCarryPath,
  phoneCursorKeys,
  slotTop,
  TIME_AT,
} from "./ep05Phone.ts";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import { RISE_POSTS } from "./rise.ts";
import { RisePostArt } from "./RisePosts";
import { Tick } from "./RisePostsCard";

const PINK = TONES.pink;
const INK = "#17151f";
const MUTED = "#6a6780";
/** How small a post rides on its ant's back, and how high. */
const CARRIED = 0.27;
const CARRY_LIFT = 74;
/** A post's art is drawn at the film's 264 px; the feed shows it at 460. */
const BIG = FEED.post / POST_SIZE;
const POST_SHADOW = "0 34px 60px -34px hsl(25 50% 20% / 0.5)";

type EpTiming = typeof EP05;

function tint(alpha: number): string {
  return PINK.color.replace(")", ` / ${alpha})`);
}

/** Top right: "Making", the count as posts arrive, "3 ready", then "3 posts scheduled". */
function Status({ t, timing }: { t: number; timing: EpTiming }) {
  const shown = smoothstep(timing.carryFrom, timing.carryFrom + 0.3, t);
  if (shown <= 0) return null;
  const landed = RISE_POSTS.filter(
    (_, i) => t >= postLandsAt(i, timing),
  ).length;
  const done = t >= timing.scheduledAt;
  const bump = t >= timing.readyAt ? 1 - progress(t, timing.readyAt, 0.4) : 0;
  const label = done
    ? "3 posts scheduled"
    : t >= timing.readyAt
      ? "3 ready"
      : landed === 0
        ? "Making"
        : `${landed} of 3 ready`;
  return (
    <div
      style={{
        position: "absolute",
        right: 40,
        top: 40,
        height: 60,
        padding: "0 26px",
        borderRadius: 999,
        background: tint(done ? 0.18 : 0.12),
        color: PINK.deep,
        fontSize: 26,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        gap: 10,
        opacity: shown,
        transform: `scale(${(1 + 0.08 * bump).toFixed(4)})`,
        transformOrigin: "right center",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {done ? <Tick size={24} color={PINK.deep} /> : null}
      {label}
    </div>
  );
}

/** What the owner asked for, typed as the voice says it. */
function Request({ t, timing }: { t: number; timing: EpTiming }) {
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
    <>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: 124,
          height: 40,
          padding: "0 18px",
          borderRadius: 999,
          background: "#f4f3f8",
          color: MUTED,
          fontSize: 22,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
        }}
      >
        You asked
      </div>
      <div
        style={{
          position: "absolute",
          left: PHONE_PAD,
          top: 176,
          width: PHONE_CARD.w - 2 * PHONE_PAD,
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: "-0.01em",
        }}
      >
        {EP05_REQUEST.slice(0, typed)}
        {caretOn ? (
          <span
            style={{
              display: "inline-block",
              width: 3,
              height: 34,
              marginLeft: 2,
              verticalAlign: "-6px",
              background: PINK.color,
            }}
          />
        ) : null}
      </div>
    </>
  );
}

/** One post in the feed: the post (or its empty slot), its time under it, its tick once scheduled. Feed-view pixels. */
function FeedItem({
  t,
  i,
  timing,
}: {
  t: number;
  i: number;
  timing: EpTiming;
}) {
  const top = slotTop(i, t) - FEED.top;
  const height = FEED.post + FEED.timeGap + FEED.timeH;
  if (top > FEED.bottom - FEED.top || top + height < -40) return null;
  const post = RISE_POSTS[i];
  const placed = t >= postLandsAt(i, timing) + 0.45;
  const time = easeOutExpo(progress(t, TIME_AT[i], 0.5));
  const tick = easeOutExpo(progress(t, timing.scheduledAt + i * 0.08, 0.4));
  return (
    <>
      {placed ? (
        <div
          style={{
            position: "absolute",
            left: FEED_LEFT,
            top,
            width: FEED.post,
            height: FEED.post,
            borderRadius: 36,
            overflow: "hidden",
            boxShadow: POST_SHADOW,
          }}
        >
          <div
            style={{
              width: POST_SIZE,
              height: POST_SIZE,
              transform: `scale(${BIG.toFixed(5)})`,
              transformOrigin: "0 0",
            }}
          >
            <RisePostArt id={post.id} />
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: FEED_LEFT,
            top,
            width: FEED.post,
            height: FEED.post,
            borderRadius: 36,
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
            left: FEED_LEFT + FEED.post - 42,
            top: top - 18,
            width: 60,
            height: 60,
            borderRadius: 30,
            background: PINK.color,
            border: "4px solid #ffffff",
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${tick.toFixed(4)})`,
          }}
        >
          <Tick size={30} color="#ffffff" />
        </div>
      ) : null}
      {time > 0 ? (
        <div
          style={{
            position: "absolute",
            left: FEED_LEFT,
            top: top + FEED.post + FEED.timeGap,
            height: FEED.timeH,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 30,
            fontWeight: 700,
            color: INK,
            opacity: time,
            transform: `translateY(${((1 - time) * 14).toFixed(2)}px)`,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <AntBadge color={PINK.color} size={40} />
          {post.when}
        </div>
      ) : null}
    </>
  );
}

/** A post leaving its ant's back for its slot (which may be below the fold). Feed-view pixels. */
function FlyingPost({
  t,
  i,
  timing,
}: {
  t: number;
  i: number;
  timing: EpTiming;
}) {
  const land = postLandsAt(i, timing);
  const fly = easeOutExpo(progress(t, land, 0.45));
  if (t < land || fly >= 1) return null;
  const from = {
    x: DROP.x - PHONE_CARD.x,
    y: DROP.y - CARRY_LIFT - PHONE_CARD.y - FEED.top,
  };
  const to = {
    x: FEED_LEFT + FEED.post / 2,
    y: slotTop(i, t) - FEED.top + FEED.post / 2,
  };
  const scale = lerp(CARRIED, BIG, fly);
  return (
    <div
      style={{
        position: "absolute",
        left: lerp(from.x, to.x, fly) - POST_SIZE / 2,
        top: lerp(from.y, to.y, fly) - POST_SIZE / 2,
        width: POST_SIZE,
        height: POST_SIZE,
        borderRadius: 22,
        overflow: "hidden",
        boxShadow: POST_SHADOW,
        transform: `scale(${scale.toFixed(4)})`,
      }}
    >
      <RisePostArt id={RISE_POSTS[i].id} />
    </div>
  );
}

/** The Approve button pinned to the card's foot, over a fade of the feed. Card pixels. */
function PinnedApprove({ t, timing }: { t: number; timing: EpTiming }) {
  const show = easeOutExpo(progress(t, timing.approveIn, 0.5));
  if (show <= 0) return null;
  const pressed = t >= timing.click && t < timing.click + 0.14 ? 0.97 : 1;
  const done = t >= timing.scheduledAt;
  const left = APPROVE.x - PHONE_CARD.x;
  const top = APPROVE.y - PHONE_CARD.y;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: top - 30,
          bottom: 0,
          background:
            "linear-gradient(to bottom, rgb(255 255 255 / 0), #ffffff 45%)",
          opacity: show,
        }}
      />
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: APPROVE.w,
          height: APPROVE.h,
          borderRadius: 999,
          background: done ? tint(0.16) : PINK.color,
          color: done ? PINK.deep : "#ffffff",
          boxShadow: done ? undefined : `0 22px 40px -20px ${tint(0.9)}`,
          fontSize: 32,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          opacity: show,
          transform: `translateY(${((1 - show) * 40).toFixed(2)}px) scale(${pressed})`,
        }}
      >
        {done ? <Tick size={30} color={PINK.deep} /> : null}
        {done ? "Scheduled" : "Approve and schedule"}
      </div>
    </>
  );
}

/** Episode 5's work on the phone card: what you asked, three big posts in a feed, their times, your yes. */
export const RisePostsPhone: React.FC<{ t: number; timing?: EpTiming }> = ({
  t,
  timing = EP05,
}) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(330 50% 35% / 0.4)">
    <div
      style={{
        position: "absolute",
        left: PHONE_PAD,
        top: 36,
        fontSize: 52,
        fontWeight: 800,
        letterSpacing: "-0.03em",
      }}
    >
      Posts.
    </div>
    <Status t={t} timing={timing} />
    <Request t={t} timing={timing} />
    <div
      style={{
        position: "absolute",
        left: 0,
        top: FEED.top,
        width: PHONE_CARD.w,
        height: FEED.bottom - FEED.top,
        overflow: "hidden",
      }}
    >
      {RISE_POSTS.map((post, i) => (
        <FeedItem key={post.id} t={t} i={i} timing={timing} />
      ))}
      {RISE_POSTS.map((post, i) => (
        <FlyingPost key={post.id} t={t} i={i} timing={timing} />
      ))}
    </div>
    <PinnedApprove t={t} timing={timing} />
  </PhoneCard>
);

/** Pink ants carrying each post in on their backs from the right edge; they fade once the post is down. Frame pixels. */
export const RisePhoneCarriers: React.FC<{ t: number; timing?: EpTiming }> = ({
  t,
  timing = EP05,
}) => (
  <>
    {RISE_POSTS.map((post, i) => {
      const start = postCarryStart(i, timing);
      if (t < start) return null;
      const land = postLandsAt(i, timing);
      const gone = smoothstep(land + 0.15, land + 0.55, t);
      if (gone >= 1) return null;
      const s = walkState(phoneCarryPath(i), t, start, timing.carryDuration);
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
                borderRadius: 22,
                overflow: "hidden",
                boxShadow: POST_SHADOW,
                transform: `rotate(${sway.toFixed(2)}deg) scale(${CARRIED})`,
              }}
            >
              <RisePostArt id={post.id} />
            </div>
          ) : null}
          <WorkerAnt
            x={s.x}
            y={s.y}
            angle={s.angle}
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

/** The owner's pointer, onto the pinned Approve at the yes. Frame pixels. */
export const PhoneApproveCursor: React.FC<{
  t: number;
  timing?: EpTiming;
}> = ({ t, timing = EP05 }) => {
  if (t < timing.cursorFrom) return null;
  const opacity =
    smoothstep(timing.cursorFrom, timing.cursorFrom + 0.3, t) *
    (1 - smoothstep(timing.click + 0.7, timing.click + 1.1, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={phoneCursorKeys(timing)}
      clicks={[timing.click]}
      opacity={opacity}
    />
  );
};
