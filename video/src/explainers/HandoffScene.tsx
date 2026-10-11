import { Cursor } from "../launch/app/Cursor";
import { INTER } from "../launch/fonts";
import { easeOutExpo, progress, smoothstep } from "../launch/math.ts";
import type { Lead } from "../launch/wide/beat.ts";
import { tickRect } from "../launch/wide/beat.ts";
import type { Tone } from "../launch/wide/employees.ts";
import { restKeys, tickKeys } from "./approve.ts";
import {
  CHIP,
  chipAt,
  chipLeaves,
  HANDOFF_APPROVE,
  HANDOFF_CARD,
  type HandoffTiming,
} from "./handoff.ts";

const INK = "#17151f";
const LINE = "#ece9f4";

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

type Pick = { row: number; at: number };

/** The owner's pointer ticking the picked rows, top to bottom. */
export const TickPointer: React.FC<{
  t: number;
  picks: readonly Pick[];
  cursorFrom: number;
}> = ({ t, picks, cursorFrom }) => {
  if (t < cursorFrom) return null;
  const clicks = picks.map((p) => p.at);
  const last = clicks[clicks.length - 1];
  const opacity =
    smoothstep(cursorFrom, cursorFrom + 0.3, t) *
    (1 - smoothstep(last + 0.5, last + 0.9, t));
  if (opacity <= 0) return null;
  return (
    <Cursor
      t={t}
      keys={tickKeys(
        picks.map((p) => tickRect(p.row)),
        clicks,
        cursorFrom,
      )}
      clicks={clicks}
      opacity={opacity}
    />
  );
};

/** The sales employee's card: where the picks land, and the Approve that waits for the owner. */
export const HandoffCard: React.FC<{
  t: number;
  tone: Tone;
  count: number;
  timing: { handoffIn: number; approveIn: number };
}> = ({ t, tone, count, timing }) => {
  const enter = easeOutExpo(progress(t, timing.handoffIn, 0.6));
  if (enter <= 0) return null;
  const button = easeOutExpo(progress(t, timing.approveIn, 0.45));
  const wait =
    t > timing.approveIn + 0.45 ? (t - timing.approveIn - 0.45) % 1.4 : -1;
  const ring = wait >= 0 ? wait / 1.4 : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: HANDOFF_CARD.x,
        top: HANDOFF_CARD.y,
        width: HANDOFF_CARD.w,
        height: HANDOFF_CARD.h,
        borderRadius: 28,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxShadow: `0 40px 80px -44px ${tint(tone.color, 0.55)}`,
        fontFamily: INTER,
        color: INK,
        opacity: enter,
        transform: `translateY(${((1 - enter) * 30).toFixed(2)}px)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 28,
          top: 22,
          fontSize: 28,
          fontWeight: 750,
          letterSpacing: "-0.015em",
        }}
      >
        Emails to your {count} picks
      </div>
      {button > 0 ? (
        <div
          style={{
            position: "absolute",
            left: HANDOFF_APPROVE.x - HANDOFF_CARD.x,
            top: HANDOFF_APPROVE.y - HANDOFF_CARD.y,
            width: HANDOFF_APPROVE.w,
            height: HANDOFF_APPROVE.h,
            borderRadius: 999,
            background: tone.color,
            color: "#ffffff",
            fontSize: 26,
            fontWeight: 750,
            display: "grid",
            placeItems: "center",
            opacity: button,
            transform: `scale(${(0.85 + 0.15 * button).toFixed(4)})`,
            boxShadow:
              ring > 0
                ? `0 0 0 ${(12 * ring).toFixed(2)}px ${tint(tone.color, 0.3 * (1 - ring))}, 0 16px 28px -14px ${tint(tone.color, 0.9)}`
                : `0 16px 28px -14px ${tint(tone.color, 0.9)}`,
          }}
        >
          Approve
        </div>
      ) : null}
    </div>
  );
};

/** Each picked lead as a small chip: off its row, down beside the board, into the sales employee's card. */
export const PickChips: React.FC<{
  t: number;
  picks: readonly Pick[];
  leads: readonly Lead[];
  color: string;
  timing: HandoffTiming;
}> = ({ t, picks, leads, color, timing }) => (
  <>
    {picks.map((p, k) => {
      const from = chipLeaves(k, timing);
      if (t < from) return null;
      const { x, y } = chipAt(k, p.row, t, timing);
      const lift = progress(t, from, timing.chipFlight);
      const pop = easeOutExpo(progress(t, from, 0.25));
      const scale = (0.6 + 0.4 * pop) * (1 + 0.12 * Math.sin(Math.PI * lift));
      return (
        <div
          key={p.row}
          style={{
            position: "absolute",
            left: x - CHIP / 2,
            top: y - CHIP / 2,
            width: CHIP,
            height: CHIP,
            borderRadius: CHIP / 2,
            background: color,
            border: "3px solid #ffffff",
            boxSizing: "border-box",
            boxShadow: `0 10px 20px -8px ${tint(color, 0.8)}`,
            color: "#ffffff",
            fontFamily: INTER,
            fontSize: 20,
            fontWeight: 750,
            display: "grid",
            placeItems: "center",
            transform: `scale(${scale.toFixed(4)})`,
          }}
        >
          {leads[p.row].name[0]}
        </div>
      );
    })}
  </>
);

/** The owner's pointer comes to rest on Approve and stays there, unpressed. */
export const RestPointer: React.FC<{
  t: number;
  timing: { restFrom: number; restAt: number };
}> = ({ t, timing }) => {
  if (t < timing.restFrom) return null;
  return (
    <Cursor
      t={t}
      keys={restKeys(HANDOFF_APPROVE, timing)}
      clicks={[]}
      opacity={smoothstep(timing.restFrom, timing.restFrom + 0.3, t)}
    />
  );
};
