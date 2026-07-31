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
          <circle cx="352" cy="136" r="11" fill="#000" />
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
        <path d="M188 226 L136 292" />
        <path d="M216 234 L196 298" />
        <path d="M240 236 L246 300" />
        <path d="M262 233 L294 294" />
        <path d="M281 226 L336 282" />
        <path d="M172 220 L112 272" />
      </g>
      {/* Antennae */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
      >
        <path d="M344 114 Q362 64 414 50" />
        <path d="M360 126 Q394 86 444 80" />
      </g>
      {/* Body: abdomen, thorax, head. Head carries the eye cutout. */}
      <g mask={`url(#${maskId})`}>
        <circle cx="104" cy="172" r="80" />
        <circle cx="226" cy="164" r="52" />
        <circle cx="330" cy="148" r="46" />
      </g>
    </svg>
  );
}
