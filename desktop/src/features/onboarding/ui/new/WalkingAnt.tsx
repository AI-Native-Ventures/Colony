// desktop/src/features/onboarding/ui/new/WalkingAnt.tsx
// Straight port of site/src/brand/WalkingAnt.tsx, which is itself a hand-synced
// copy of desktop/src/shared/ui/colony-logo/WalkingAnt.tsx. Structure and path
// geometry are kept identical to those files; geometry ultimately comes from
// docs/BRAND.md. The gait stylesheet is not imported here: onboarding-canvas.css
// already carries the ant-sprite gait rules and their reduced-motion fallback,
// scoped to this feature's canvas.
import { useId } from "react";

/**
 * The Colony ant mark with a walking-leg gait, rendered in `currentColor`.
 *
 * Each leg tripod is its own HTML-level `<svg>` layer and the gait animates
 * those elements' CSS transforms. This is deliberate: WebKit paints SVG
 * children on the main thread, so a transform animation on a `<path>` freezes
 * for as long as boot work hogs the thread, exactly the window in which a
 * loading gate is on screen. Transforms on HTML-level elements run on the
 * compositor and keep stepping regardless.
 *
 * Everything is plain SVG + CSS (no JS, no SMIL), so it paints on the very
 * first frame. Reduced motion falls back to the static stance via the CSS
 * media query in onboarding-canvas.css.
 */
export function WalkingAnt({ className }: { className?: string }) {
  const maskId = `walking-ant-eye-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const legLayer = "ant-leg-layer absolute inset-0";
  const legSvg = "block h-full w-full";
  const legStroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 14,
    strokeLinecap: "round" as const,
  };

  return (
    <div
      aria-hidden="true"
      className={[
        "colony-mark",
        "ant-sprite",
        "relative",
        "aspect-[466/309]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Tripod A: rear-swing, front, middle-back */}
      <div className={`${legLayer} ant-leg-layer-a`}>
        <svg aria-hidden="true" className={`${legSvg}`} viewBox="0 0 466 309">
          <g {...legStroke}>
            <path d="M257 198 L336 282" />
            <path d="M220 210 L196 298" />
            <path d="M164 215 L112 272" />
          </g>
        </svg>
      </div>
      {/* Tripod B: mid-front, center, back */}
      <div className={`${legLayer} ant-leg-layer-b`}>
        <svg aria-hidden="true" className={`${legSvg}`} viewBox="0 0 466 309">
          <g {...legStroke}>
            <path d="M247 205 L294 294" />
            <path d="M235 209 L246 300" />
            <path d="M202 203 L136 292" />
          </g>
        </svg>
      </div>
      {/* Body last in DOM order so it paints over the leg roots, plus the
          antennae, which bob with the body layer. */}
      <div className="ant-body-layer relative h-full w-full">
        <svg
          aria-hidden="true"
          className="block h-full w-full"
          viewBox="0 0 466 309"
          fill="currentColor"
        >
          <defs>
            <mask
              id={maskId}
              x="-80"
              y="-80"
              width="626"
              height="469"
              maskUnits="userSpaceOnUse"
              maskContentUnits="userSpaceOnUse"
            >
              <rect x="-80" y="-80" width="626" height="469" fill="#fff" />
              <circle cx="335" cy="136" r="11" fill="#000" />
            </mask>
          </defs>
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="14"
            strokeLinecap="round"
          >
            <path d="M327 114 Q345 64 397 50" />
            <path d="M343 126 Q377 86 427 80" />
          </g>
          <g mask={`url(#${maskId})`}>
            <circle cx="104" cy="172" r="80" />
            <circle cx="226" cy="164" r="52" />
            <circle cx="313" cy="148" r="46" />
          </g>
        </svg>
      </div>
    </div>
  );
}
