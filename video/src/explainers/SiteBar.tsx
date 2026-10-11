import { INTER } from "../launch/fonts";
import { easeOutExpo, progress } from "../launch/math.ts";
import type { Tone } from "../launch/wide/employees.ts";
import { Tick } from "./kit";

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

/**
 * The right end of the website card's browser bar in a site editor: a
 * Before and After switch, then Approve, which turns into Live. Fixed
 * widths, so the episode knows where the button is.
 */
export const SiteBarControls: React.FC<{
  t: number;
  tone: Tone;
  timing: {
    toggleIn: number;
    beforeFrom: number;
    beforeUntil: number;
    approveIn: number;
    click: number;
    liveAt: number;
  };
}> = ({ t, tone, timing }) => {
  const toggle = easeOutExpo(progress(t, timing.toggleIn, 0.45));
  const button = easeOutExpo(progress(t, timing.approveIn, 0.45));
  const before = t >= timing.beforeFrom && t < timing.beforeUntil;
  const live = t >= timing.liveAt;
  const pressed = t >= timing.click && t < timing.click + 0.14 ? 0.95 : 1;
  const bump = live ? 1 - progress(t, timing.liveAt, 0.4) : 0;
  const segment = (label: string, on: boolean) => (
    <span
      style={{
        flex: 1,
        height: 36,
        borderRadius: 999,
        display: "grid",
        placeItems: "center",
        background: on ? "#ffffff" : "transparent",
        boxShadow: on ? "0 2px 8px -2px rgb(0 0 0 / 0.18)" : undefined,
        color: on ? tone.deep : "#6a6780",
        fontSize: 20,
        fontWeight: on ? 750 : 600,
      }}
    >
      {label}
    </span>
  );
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: INTER,
      }}
    >
      <span
        style={{
          width: 220,
          height: 44,
          borderRadius: 999,
          background: "#f0eff5",
          padding: 4,
          boxSizing: "border-box",
          display: "flex",
          opacity: toggle,
        }}
      >
        {segment("Before", before)}
        {segment("After", !before)}
      </span>
      <span
        style={{
          width: 170,
          height: 44,
          borderRadius: 999,
          background: live ? tint(tone.color, 0.16) : tone.color,
          color: live ? tone.deep : "#ffffff",
          fontSize: 21,
          fontWeight: 750,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: button,
          transform: `scale(${((0.85 + 0.15 * button) * pressed * (1 + 0.06 * bump)).toFixed(4)})`,
          boxShadow: live
            ? undefined
            : `0 12px 22px -12px ${tint(tone.color, 0.9)}`,
        }}
      >
        {live ? <Tick size={20} color={tone.deep} /> : null}
        {live ? "Live" : "Approve"}
      </span>
    </span>
  );
};
