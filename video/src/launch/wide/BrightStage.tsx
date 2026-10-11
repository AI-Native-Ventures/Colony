/** The bright product world: near white with soft color blooms, revealed as a growing circle. */
export const BrightStage: React.FC<{
  reveal: number;
  cx: number;
  cy: number;
  /** Off when the scene paints its own color blooms. */
  blooms?: boolean;
  /** "mask" grows a circle from (cx, cy); "fade" crossfades, for a light world behind. */
  transition?: "mask" | "fade";
  children?: React.ReactNode;
}> = ({ reveal, cx, cy, blooms = true, transition = "mask", children }) => {
  if (reveal <= 0) return null;
  const radius = reveal * 2600 - 300;
  const mask =
    reveal >= 1 || transition === "fade"
      ? undefined
      : `radial-gradient(circle at ${cx}px ${cy}px, #000 ${Math.max(0, radius).toFixed(1)}px, transparent ${(Math.max(0, radius) + 420).toFixed(1)}px)`;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "#fbfaff",
        opacity: transition === "fade" ? reveal : 1,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    >
      {blooms ? <Blooms /> : null}
      {children}
    </div>
  );
};

/** The proof beat's fixed blooms: blue top left, lavender bottom right, a hint of green. */
const Blooms: React.FC = () => (
  <>
    <div
      style={{
        position: "absolute",
        left: -320,
        top: -400,
        width: 1300,
        height: 1100,
        background:
          "radial-gradient(closest-side, hsl(217 91% 72% / 0.22), transparent)",
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
          "radial-gradient(closest-side, hsl(258 90% 76% / 0.3), transparent)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 640,
        bottom: -520,
        width: 1100,
        height: 900,
        background:
          "radial-gradient(closest-side, hsl(160 60% 70% / 0.14), transparent)",
      }}
    />
  </>
);
