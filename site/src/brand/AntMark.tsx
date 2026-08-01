// site/src/brand/AntMark.tsx
// Standalone copy of desktop/src/shared/ui/colony-logo/AntMark.tsx. The site
// package cannot import desktop source, so geometry here is kept in sync by
// hand against that file and docs/BRAND.md, the source of truth for both.
import { useId } from "react";

/**
 * The Colony ant mark as a plain static SVG. No SMIL, no scripting. Rendered
 * in `currentColor` so it tints per-theme, and it paints complete on the very
 * first frame regardless of animation support. Geometry is shared with
 * {@link WalkingAnt} (same viewBox and coordinates) so the static and
 * animated marks are pixel-identical at rest.
 */
export function AntMark({ className }: { className?: string }) {
  const maskId = `colony-mark-eye-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      aria-hidden="true"
      className={["colony-mark", className].filter(Boolean).join(" ")}
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
      {/* Legs: two tripods (a: front-right stance, b: back stance). Drawn
          first so the body covers the roots. */}
      <g
        className="colony-legs"
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
      >
        <path d="M202 203 L136 292" />
        <path d="M220 210 L196 298" />
        <path d="M235 209 L246 300" />
        <path d="M247 205 L294 294" />
        <path d="M257 198 L336 282" />
        <path d="M164 215 L112 272" />
      </g>
      {/* Antennae */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
      >
        <path d="M327 114 Q345 64 397 50" />
        <path d="M343 126 Q377 86 427 80" />
      </g>
      {/* Body: abdomen, thorax, head. Head carries the eye cutout. */}
      <g mask={`url(#${maskId})`}>
        <circle cx="104" cy="172" r="80" />
        <circle cx="226" cy="164" r="52" />
        <circle cx="313" cy="148" r="46" />
      </g>
    </svg>
  );
}
