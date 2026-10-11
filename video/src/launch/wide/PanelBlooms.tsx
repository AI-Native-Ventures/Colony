import type { Tone } from "./employees.ts";

function soft(color: string, alpha: number): string {
  return color.replace(
    /(\d+)%\)$/,
    (_, l) => `${Math.min(80, Number(l) + 14)}% / ${alpha})`,
  );
}

/** One employee's soft light: its own hue top left, the brand lavender bottom right. */
export const PanelBlooms: React.FC<{ tone: Tone }> = ({ tone }) => (
  <>
    <div
      style={{
        position: "absolute",
        left: -320,
        top: -400,
        width: 1300,
        height: 1100,
        background: `radial-gradient(closest-side, ${soft(tone.color, 0.22)}, transparent)`,
      }}
    />
    <div
      style={{
        position: "absolute",
        right: -380,
        bottom: -440,
        width: 1500,
        height: 1200,
        background:
          "radial-gradient(closest-side, hsl(258 90% 76% / 0.26), transparent)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 640,
        bottom: -520,
        width: 1100,
        height: 900,
        background: `radial-gradient(closest-side, ${soft(tone.color, 0.12)}, transparent)`,
      }}
    />
  </>
);
