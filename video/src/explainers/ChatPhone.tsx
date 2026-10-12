import { AntMark } from "../brand/AntMark";
import { easeOutExpo, progress } from "../launch/math.ts";
import { SCOUT_LOOK, type Tone } from "../launch/wide/employees.ts";
import { ICON_TONE, ThreadGlyph } from "./ChatCard";
import { EP08, EP08_REPLY } from "./ep08.ts";
import {
  LIST,
  MENU_SCALE,
  PUSH_AT,
  PUSH_SECONDS,
  TAP_AT,
  THREAD_PHONE as TH,
  THREAD_VIEW,
  threadScroll,
} from "./ep08Phone.ts";
import { MenuCard } from "./MenuCard";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD, PHONE_PAD } from "./phone.ts";
import { PhonePush, PhoneTitle, PinnedButton, tint } from "./phoneKit";
import { MENU_AFTER, MENU_BEFORE, THREADS } from "./thandi.ts";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";

type Timing = typeof EP08;

/** The chat list: one chat per topic, each lit as it is named, Weddings tapped at the end. */
function ChatList({
  t,
  tone,
  timing,
}: {
  t: number;
  tone: Tone;
  timing: Timing;
}) {
  const first = easeOutExpo(progress(t, timing.cardIn + 0.4, 0.6));
  const press = t >= TAP_AT && t < TAP_AT + 0.25 ? 1 : 0;
  const ripple = progress(t, TAP_AT, 0.5);
  return (
    <>
      <PhoneTitle text="Chats" />
      {THREADS.map((th, i) => {
        const named = timing.threadsAt[i];
        const pulse = t >= named ? 1 - progress(t, named, 0.9) : 0;
        const shown = Math.max(
          i === 0 ? first : 0,
          easeOutExpo(progress(t, named - 0.15, 0.4)),
        );
        if (shown <= 0) return null;
        const top = LIST.top + i * LIST.step;
        const pressed = i === 0 ? press : 0;
        return (
          <div
            key={th.name}
            style={{
              position: "absolute",
              left: 24,
              right: 24,
              top,
              height: LIST.h,
              borderRadius: 26,
              overflow: "hidden",
              background:
                pressed > 0
                  ? tint(tone.color, 0.18)
                  : pulse > 0
                    ? tint(tone.color, 0.1 * pulse)
                    : i === 0
                      ? tint(tone.color, 0.06)
                      : "transparent",
              boxShadow:
                pulse > 0
                  ? `0 0 0 ${(3 * pulse).toFixed(2)}px ${tint(tone.color, 0.5 * pulse)}`
                  : undefined,
              opacity: shown,
              transform: `translateY(${((1 - shown) * 16).toFixed(2)}px) scale(${(1 + 0.03 * pulse - 0.02 * pressed).toFixed(4)})`,
            }}
          >
            {i === 0 && ripple > 0 && ripple < 1 ? (
              <div
                style={{
                  position: "absolute",
                  left: 360 - 400 * ripple,
                  top: LIST.h / 2 - 400 * ripple,
                  width: 800 * ripple,
                  height: 800 * ripple,
                  borderRadius: "50%",
                  background: tint(tone.color, 0.16 * (1 - ripple)),
                }}
              />
            ) : null}
            <span
              style={{
                position: "absolute",
                left: 22,
                top: 24,
                width: 84,
                height: 84,
                borderRadius: 42,
                background: ICON_TONE[th.icon].color,
                display: "grid",
                placeItems: "center",
              }}
            >
              <span style={{ display: "flex", transform: "scale(1.6)" }}>
                <ThreadGlyph icon={th.icon} />
              </span>
            </span>
            <div
              style={{
                position: "absolute",
                left: 128,
                top: 20,
                fontSize: 38,
                fontWeight: 750,
                color: INK,
              }}
            >
              {th.name}
            </div>
            <div
              style={{
                position: "absolute",
                left: 128,
                right: 24,
                top: 72,
                fontSize: 27,
                color: MUTED,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {th.preview}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Scout's message: the team's ant on violet, its name, the words. Thread pixels. */
function ScoutMessage({
  y,
  text,
  opacity,
}: {
  y: number;
  text: string;
  opacity: number;
}) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: y, opacity }}>
      <span
        style={{
          position: "absolute",
          left: 32,
          top: 0,
          width: 56,
          height: 56,
          borderRadius: 28,
          background: SCOUT_LOOK.color,
          display: "grid",
          placeItems: "center",
        }}
      >
        <span style={{ display: "flex", width: 35, height: 23, color: "#fff" }}>
          <AntMark />
        </span>
      </span>
      <div
        style={{
          position: "absolute",
          left: 104,
          top: -2,
          fontSize: 26,
          fontWeight: 750,
          color: INK,
        }}
      >
        Scout
      </div>
      <div
        style={{
          position: "absolute",
          left: 104,
          width: PHONE_CARD.w - 104 - PHONE_PAD,
          top: 34,
          fontSize: 28,
          fontWeight: 500,
          lineHeight: 1.3,
          color: "#2b2838",
        }}
      >
        {text}
      </div>
    </div>
  );
}

/** A menu sent in the thread, the wide film's card shown bigger. Thread pixels. */
function SentMenu({
  x,
  y,
  courses,
  tag,
  opacity,
  rise,
}: {
  x: number;
  y: number;
  courses: typeof MENU_BEFORE;
  tag?: string;
  opacity: number;
  rise: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 280,
        height: 420,
        opacity,
        transform: `translateY(${rise.toFixed(2)}px) scale(${MENU_SCALE})`,
        transformOrigin: "0 0",
      }}
    >
      <MenuCard w={280} h={420} courses={courses} tag={tag} />
    </div>
  );
}

/** The Weddings thread: Scout's menu, your reply on it, the new menu. */
function Thread({
  t,
  tone,
  timing,
}: {
  t: number;
  tone: Tone;
  timing: Timing;
}) {
  const replyIn = easeOutExpo(progress(t, timing.replyIn, 0.45));
  const typed = Math.max(
    0,
    Math.min(
      EP08_REPLY.length,
      Math.floor((t - timing.replyFrom) * timing.replyCps),
    ),
  );
  const back = easeOutExpo(progress(t, timing.backAt + 0.3, 0.6));
  const scroll = threadScroll(t);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: THREAD_VIEW.top,
          borderBottom: `1.5px solid ${LINE}`,
          boxSizing: "border-box",
        }}
      >
        <svg
          aria-hidden="true"
          width="36"
          height="36"
          viewBox="0 0 24 24"
          style={{ position: "absolute", left: 28, top: 44 }}
        >
          <path
            d="M15 5l-7 7 7 7"
            fill="none"
            stroke={tone.color}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div
          style={{
            position: "absolute",
            left: 78,
            top: 24,
            fontSize: 42,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: INK,
          }}
        >
          Weddings
        </div>
        <div
          style={{
            position: "absolute",
            left: 80,
            top: 80,
            fontSize: 22,
            color: MUTED,
          }}
        >
          You, Scout and the team
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: THREAD_VIEW.top,
          bottom: 0,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            transform: `translateY(${(-scroll).toFixed(2)}px)`,
          }}
        >
          <ScoutMessage
            y={TH.scout1.y}
            text="The menu for Zanele and Sipho's wedding."
            opacity={1}
          />
          <SentMenu
            x={TH.menu1.x}
            y={TH.menu1.y}
            courses={MENU_BEFORE}
            opacity={1}
            rise={0}
          />
          {replyIn > 0 ? (
            <div
              style={{
                position: "absolute",
                right: PHONE_PAD,
                top: TH.reply.y,
                width: 560,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                opacity: replyIn,
                transform: `translateY(${((1 - replyIn) * 16).toFixed(2)}px)`,
              }}
            >
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 650,
                  color: MUTED,
                  marginBottom: 8,
                }}
              >
                You, replying to the menu
              </div>
              <div
                style={{
                  minHeight: 46,
                  maxWidth: 560,
                  padding: "18px 26px",
                  borderRadius: "28px 28px 8px 28px",
                  background: tone.color,
                  color: "#ffffff",
                  fontSize: 30,
                  fontWeight: 600,
                  lineHeight: 1.3,
                }}
              >
                {EP08_REPLY.slice(0, typed)}
                {typed < EP08_REPLY.length ? (
                  <span
                    style={{
                      display: "inline-block",
                      width: 3,
                      height: 32,
                      marginLeft: 2,
                      verticalAlign: "-5px",
                      background: "#ffffff",
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
          {back > 0 ? (
            <>
              <ScoutMessage
                y={TH.scout2.y}
                text="Done. Every course has a vegetarian choice."
                opacity={back}
              />
              <SentMenu
                x={TH.menu2.x}
                y={TH.menu2.y}
                courses={MENU_AFTER}
                tag="Vegetarian-friendly"
                opacity={back}
                rise={(1 - back) * 24}
              />
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Episode 8's work on the phone card: the chats, the Weddings thread, your reply, the new menu, your yes. */
export const ChatPhone: React.FC<{
  t: number;
  tone: Tone;
  timing?: Timing;
}> = ({ t, tone, timing = EP08 }) => (
  <PhoneCard t={t} enterAt={timing.cardIn} glow="hsl(258 60% 40% / 0.45)">
    <PhonePush
      t={t}
      at={PUSH_AT}
      seconds={PUSH_SECONDS}
      first={<ChatList t={t} tone={tone} timing={timing} />}
      second={<Thread t={t} tone={tone} timing={timing} />}
    />
    <PinnedButton
      t={t}
      tone={tone}
      idle="Approve"
      done="Approved"
      timing={{
        approveIn: timing.approveIn,
        click: timing.click,
        doneAt: timing.approvedAt,
      }}
    />
  </PhoneCard>
);
