import { AntMark } from "../brand/AntMark";
import { INTER } from "../launch/fonts";
import { easeInOutCubic, easeOutExpo, progress } from "../launch/math.ts";
import { SCOUT_LOOK, TONES, type Tone } from "../launch/wide/employees.ts";
import { MenuCard } from "./MenuCard";
import {
  CHAT_CARD as CARD,
  MENU_AFTER,
  MENU_BEFORE,
  SIDEBAR_W,
  THREAD,
  THREAD_HEADER_H,
  THREAD_VIEW_H,
  THREADS,
  type ThreadIcon,
} from "./thandi.ts";

const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

export type ChatTiming = {
  cardIn: number;
  /** When each topic is named, in sidebar order. */
  threadsAt: readonly [number, number, number];
  replyIn: number;
  replyFrom: number;
  replyCps: number;
  /** When the new menu comes back and the thread scrolls to it. */
  backAt: number;
};

/** The thread scroll, in thread pixels. */
export function chatScroll(t: number, timing: ChatTiming): number {
  return THREAD.scroll * easeInOutCubic(progress(t, timing.backAt, 0.8));
}

const ICON_TONE: Record<ThreadIcon, Tone> = {
  heart: TONES.pink,
  fork: TONES.amber,
  globe: TONES.green,
};

function ThreadGlyph({ icon }: { icon: ThreadIcon }) {
  const common = {
    fill: "none",
    stroke: "#ffffff",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24">
      {icon === "heart" ? (
        <path
          d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"
          {...common}
        />
      ) : icon === "fork" ? (
        <path
          d="M7 3v8a2 2 0 0 0 4 0V3M9 11v10M16 3c-2 1.5-2 6 0 7.5V21"
          {...common}
        />
      ) : (
        <>
          <circle cx="12" cy="12" r="8.5" {...common} />
          <path
            d="M3.5 12h17M12 3.5c2.6 2.5 2.6 14.5 0 17M12 3.5c-2.6 2.5-2.6 14.5 0 17"
            {...common}
          />
        </>
      )}
    </svg>
  );
}

function ScoutLine({ text }: { text: string }) {
  return (
    <div style={{ position: "relative", height: 70 }}>
      <span
        style={{
          position: "absolute",
          left: 28,
          top: 0,
          width: 48,
          height: 48,
          borderRadius: 24,
          background: SCOUT_LOOK.color,
          display: "grid",
          placeItems: "center",
        }}
      >
        <span style={{ display: "flex", width: 30, height: 20, color: "#fff" }}>
          <AntMark />
        </span>
      </span>
      <div
        style={{
          position: "absolute",
          left: 90,
          top: -2,
          fontSize: 22,
          fontWeight: 750,
        }}
      >
        Scout
      </div>
      <div
        style={{
          position: "absolute",
          left: 90,
          top: 28,
          fontSize: 25,
          fontWeight: 500,
          color: "#2b2838",
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </div>
    </div>
  );
}

/**
 * The owner's chats: one per topic down the side, the Weddings thread open.
 * The owner replies right on the menu, and the new menu comes back in the
 * same thread.
 */
export const ChatCard: React.FC<{
  t: number;
  tone: Tone;
  timing: ChatTiming;
  reply: string;
}> = ({ t, tone, timing, reply }) => {
  const enter = easeOutExpo(progress(t, timing.cardIn, 0.9));
  if (enter <= 0) return null;
  const first = easeOutExpo(progress(t, timing.cardIn + 0.5, 0.6));
  const replyIn = easeOutExpo(progress(t, timing.replyIn, 0.45));
  const typed = Math.max(
    0,
    Math.min(
      reply.length,
      Math.floor((t - timing.replyFrom) * timing.replyCps),
    ),
  );
  const back = easeOutExpo(progress(t, timing.backAt + 0.3, 0.6));
  const scroll = chatScroll(t, timing);
  return (
    <div
      style={{
        position: "absolute",
        left: CARD.x,
        top: CARD.y,
        width: CARD.w,
        height: CARD.h,
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
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: SIDEBAR_W,
          background: "#faf9fd",
          borderRight: `1.5px solid ${LINE}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 28,
            top: 30,
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: "-0.02em",
          }}
        >
          Chats
        </div>
        {THREADS.map((th, i) => {
          const named = timing.threadsAt[i];
          const pulse = t >= named ? 1 - progress(t, named, 0.9) : 0;
          const shown = easeOutExpo(progress(t, named - 0.15, 0.4));
          const active = i === 0;
          const iconTone = ICON_TONE[th.icon];
          return (
            <div
              key={th.name}
              style={{
                position: "absolute",
                left: 14,
                right: 14,
                top: 96 + i * 100,
                height: 86,
                borderRadius: 18,
                background: active
                  ? tint(tone.color, 0.1)
                  : pulse > 0
                    ? tint(tone.color, 0.08 * pulse)
                    : "transparent",
                boxShadow:
                  pulse > 0
                    ? `0 0 0 ${(3 * pulse).toFixed(2)}px ${tint(tone.color, 0.5 * pulse)}`
                    : undefined,
                opacity: Math.max(i === 0 ? first : 0, shown),
                transform: `scale(${(1 + 0.04 * pulse).toFixed(4)})`,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 14,
                  top: 17,
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  background: iconTone.color,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <ThreadGlyph icon={th.icon} />
              </span>
              <div
                style={{
                  position: "absolute",
                  left: 80,
                  top: 14,
                  fontSize: 24,
                  fontWeight: 750,
                }}
              >
                {th.name}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 80,
                  right: 10,
                  top: 46,
                  fontSize: 17,
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
      </div>
      <div
        style={{
          position: "absolute",
          left: SIDEBAR_W,
          right: 0,
          top: 0,
          height: THREAD_HEADER_H,
          borderBottom: `1.5px solid ${LINE}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 32,
            top: 18,
            fontSize: 32,
            fontWeight: 800,
            letterSpacing: "-0.02em",
          }}
        >
          Weddings
        </div>
        <div
          style={{
            position: "absolute",
            left: 32,
            top: 58,
            fontSize: 19,
            color: MUTED,
          }}
        >
          You, Scout and the team
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: SIDEBAR_W,
          right: 0,
          top: THREAD_HEADER_H,
          height: THREAD_VIEW_H,
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
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 24,
              opacity: first,
            }}
          >
            <ScoutLine text="The menu for Zanele and Sipho's wedding." />
          </div>
          <div
            style={{
              position: "absolute",
              left: THREAD.firstMenu.x,
              top: THREAD.firstMenu.y,
              opacity: first,
              transform: `translateY(${((1 - first) * 20).toFixed(2)}px)`,
            }}
          >
            <MenuCard
              w={THREAD.firstMenu.w}
              h={THREAD.firstMenu.h}
              courses={MENU_BEFORE}
            />
          </div>
          {replyIn > 0 ? (
            <div
              style={{
                position: "absolute",
                right: 28,
                top: THREAD.reply.y,
                width: 470,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                opacity: replyIn,
                transform: `translateY(${((1 - replyIn) * 16).toFixed(2)}px)`,
              }}
            >
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 650,
                  color: MUTED,
                  marginBottom: 6,
                }}
              >
                You, replying to the menu
              </div>
              <div
                style={{
                  minHeight: 40,
                  maxWidth: 470,
                  padding: "14px 22px",
                  borderRadius: "22px 22px 6px 22px",
                  background: tone.color,
                  color: "#ffffff",
                  fontSize: 26,
                  fontWeight: 600,
                  lineHeight: 1.3,
                }}
              >
                {reply.slice(0, typed)}
                {typed < reply.length ? (
                  <span
                    style={{
                      display: "inline-block",
                      width: 3,
                      height: 28,
                      marginLeft: 2,
                      verticalAlign: "-4px",
                      background: "#ffffff",
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
          {back > 0 ? (
            <>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: THREAD.second.y,
                  opacity: back,
                }}
              >
                <ScoutLine text="Done. Every course has a vegetarian choice." />
              </div>
              <div
                style={{
                  position: "absolute",
                  left: THREAD.secondMenu.x,
                  top: THREAD.secondMenu.y,
                  opacity: back,
                  transform: `translateY(${((1 - back) * 24).toFixed(2)}px)`,
                }}
              >
                <MenuCard
                  w={THREAD.secondMenu.w}
                  h={THREAD.secondMenu.h}
                  courses={MENU_AFTER}
                  tag="Vegetarian-friendly"
                />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
