// site/src/brand/PheromoneTrail.tsx
// Animated dashed path connecting points: the "agents coordinating" visual
// used behind the Story section columns. Dash offset animates via CSS in
// site-animations.css (imported directly here, same pattern as
// WalkingAnt.tsx, since this component can render without WalkingAnt ever
// mounting first). Reduced motion shows the static dashed path: the CSS
// animation is simply not applied under the media query, no per-mechanism
// JS gate needed here unlike ScatterField's requestAnimationFrame loop.
import "./site-animations.css";

export function PheromoneTrail({
  d,
  color,
  className,
  viewBox = "0 0 800 300",
}: {
  d: string;
  color: string;
  className?: string;
  viewBox?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={["pheromone-trail", className].filter(Boolean).join(" ")}
      viewBox={viewBox}
      fill="none"
    >
      <path
        d={d}
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="3 9"
        className="pheromone-trail__path"
      />
    </svg>
  );
}
