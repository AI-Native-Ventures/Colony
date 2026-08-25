/**
 * Colour math for the card renderer and its gates.
 *
 * Ported from `colony-social-kit/brand/atmosphere.mjs` and
 * `colony-social-kit/tools/contrast.mjs`, which are themselves the launch
 * build's proven arithmetic. Nothing here knows about Colony: every input is
 * a colour or a ratio, every output is a colour or a number.
 */

/** 8-bit sRGB triple. */
export type Rgb = [number, number, number];

export type Hsl = { h: number; s: number; l: number };

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into an 8-bit triple (+ alpha). */
export function hexToRgb(hex: string): { rgb: Rgb; alpha: number } {
  const value = hex.replace(/^#/, "");
  const expand = (part: string): number =>
    part.length === 1
      ? Number.parseInt(part + part, 16)
      : Number.parseInt(part, 16);
  if (value.length === 3) {
    return {
      alpha: 1,
      rgb: [expand(value[0]), expand(value[1]), expand(value[2])],
    };
  }
  if (value.length !== 6 && value.length !== 8) {
    throw new Error(`not a hex colour: ${hex}`);
  }
  return {
    alpha: value.length === 8 ? expand(value.slice(6, 8)) / 255 : 1,
    rgb: [
      expand(value.slice(0, 2)),
      expand(value.slice(2, 4)),
      expand(value.slice(4, 6)),
    ],
  };
}

export function rgbToHex([r, g, b]: Rgb): string {
  const part = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** sRGB hex to HSL. `s` and `l` are 0-100, matching the CSS functional form. */
export function hexToHsl(hex: string): Hsl {
  const { rgb } = hexToRgb(hex);
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslCss({ h, s, l }: Hsl): string {
  return `hsl(${h} ${s}% ${l.toFixed(1)}%)`;
}

/** WCAG 2.1 relative luminance from 8-bit sRGB. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG relative luminance of an HSL triple (same curve, HSL input). */
export function luminanceHsl({ h, s, l }: Hsl): number {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[seg].map((v) => v + m);
  return relativeLuminance([r * 255, g * 255, b * 255]);
}

/** WCAG 2.1 contrast ratio between two 8-bit sRGB triples. */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Contrast ratio between white type and an HSL ground colour. */
export function whiteOn(hsl: Hsl): number {
  return 1.05 / (luminanceHsl(hsl) + 0.05);
}

/**
 * The lightness at which white type hits `ratio` against this hue, by
 * bisection over 0-100 lightness at fixed hue and saturation.
 *
 * This is what lets a deep card carry structure at all: the brightest band
 * allowed under white type is the one that provably measures the target, not
 * one that looked right. Port of `atL` in atmosphere.mjs.
 */
export function solveWhiteOn(baseHex: string, ratio: number): string {
  const { h, s } = hexToHsl(baseHex);
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (whiteOn({ h, s, l: mid }) > ratio) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hslCss({ h, s, l: lo });
}

/**
 * The mirror of {@link solveWhiteOn} for ink type: the darkest lightness at
 * which `inkHex` still clears `ratio` against this hue. Port of `inkAtL`.
 */
export function solveInkOn(
  baseHex: string,
  ratio: number,
  inkHex: string,
): string {
  const { h, s } = hexToHsl(baseHex);
  const inkL = luminanceHsl(hexToHsl(inkHex));
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((luminanceHsl({ h, s, l: mid }) + 0.05) / (inkL + 0.05) >= ratio) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hslCss({ h, s, l: hi });
}
