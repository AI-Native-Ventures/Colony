import { hslToRgb, lerp } from "./math.ts";

type Rgb = [number, number, number];

/** The four employees, in group order: finds customers, posts, emails, website. */
const GROUP_RGB: Rgb[] = [
  hslToRgb(217, 91, 60),
  hslToRgb(330, 81, 60),
  hslToRgb(38, 92, 50),
  hslToRgb(160, 60, 45),
];
const VIOLET_RGB: Rgb = hslToRgb(258, 90, 66);
const WHITE_RGB: Rgb = [244, 243, 248];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

/** White while the ant is still a letter, its employee color in flight, violet once it is part of the logo. */
export function antColor(
  group: number,
  toGroup: number,
  toViolet: number,
): string {
  const own = GROUP_RGB[group % GROUP_RGB.length];
  const [r, g, b] = mix(mix(WHITE_RGB, own, toGroup), VIOLET_RGB, toViolet);
  return `rgb(${r} ${g} ${b})`;
}
