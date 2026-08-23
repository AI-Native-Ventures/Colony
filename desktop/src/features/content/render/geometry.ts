/**
 * Colony mark geometry, copied verbatim from the committed source of truth by
 * way of the launch kit's brand/geometry.mjs:
 *
 *   mark      colony/desktop/src/shared/ui/colony-logo/AntMark.tsx
 *   wings     colony/site/src/brand/WingedAnt.tsx
 *
 * docs/BRAND.md records that a redrawn head position (cx=330 instead of 313)
 * already shipped wrong once. Never trace this mark by eye or from a PNG.
 */

export const VIEWBOX = "0 0 466 309";
export const ASPECT = 466 / 309;

export const LEGS = [
  "M202 203 L136 292",
  "M220 210 L196 298",
  "M235 209 L246 300",
  "M247 205 L294 294",
  "M257 198 L336 282",
  "M164 215 L112 272",
];

export const ANTENNAE = ["M327 114 Q345 64 397 50", "M343 126 Q377 86 427 80"];

export const BODY = [
  { cx: 104, cy: 172, r: 80 }, // abdomen
  { cx: 226, cy: 164, r: 52 }, // thorax
  { cx: 313, cy: 148, r: 46 }, // head
];

export const EYE = { cx: 335, cy: 136, r: 11 };

export const HIND_WING = { cx: 150, cy: 90, rx: 95, ry: 34, rotate: -24 };
export const FORE_WING = { cx: 178, cy: 112, rx: 78, ry: 27, rotate: -17 };

/** In-app UI stroke weight at native 466x309 proportions. */
export const STROKE = 14;

let uid = 0;

/**
 * The static mark as a standalone SVG string. Port of `antSvg` in the launch
 * kit's geometry.mjs.
 */
export function antSvg({
  color = "currentColor",
  winged = false,
} = {}): string {
  const maskId = `colony-eye-${uid++}`;
  const stroke =
    `<g fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round">` +
    [...LEGS, ...ANTENNAE].map((d) => `<path d="${d}"/>`).join("") +
    `</g>`;
  const body =
    `<g fill="${color}" mask="url(#${maskId})">` +
    BODY.map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/>`).join("") +
    `</g>`;
  const wings = winged
    ? [
        [HIND_WING, 0.3],
        [FORE_WING, 0.45],
      ]
        .map(
          ([w, o]) =>
            `<ellipse cx="${w.cx}" cy="${w.cy}" rx="${w.rx}" ry="${w.ry}" transform="rotate(${w.rotate} ${w.cx} ${w.cy})" fill="${color}" fill-opacity="${o}"/>`,
        )
        .join("")
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" fill="${color}">` +
    `<defs><mask id="${maskId}" x="-80" y="-80" width="626" height="469" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect x="-80" y="-80" width="626" height="469" fill="#fff"/><circle cx="${EYE.cx}" cy="${EYE.cy}" r="${EYE.r}" fill="#000"/></mask></defs>` +
    `${wings}${stroke}${body}</svg>`
  );
}
