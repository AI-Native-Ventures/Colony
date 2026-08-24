/**
 * The card ground: an oversized band-and-lobe field thrown out of focus at two
 * depths, with a specular pass and luminance-only film grain.
 *
 * Port of `colony-social-kit/brand/atmosphere.mjs` v6, whose composition took
 * nine rounds of owner review. The treatment is Sierra/OpenAI read off the
 * creative: defocused translucent material, one light source off centre,
 * creases where planes meet, enormous value range inside one frame. Nothing
 * here knows Colony: every colour arrives pre-solved through
 * {@link ResolvedGroundHue}, resolved from the brand kit by `resolveGroundHues`
 * in colonyKit.ts.
 *
 * Contrast is not left to chance here either: the slices a band may draw with
 * are solved ramp stops (see color.ts), so the brightest value allowed under
 * white type is one that provably measures its ratio, and alpha compositing
 * between stops can only land between them.
 */

import { hexToHsl, luminanceHsl } from "./color.ts";

/** The two ground families. Night carries white type on deep ramps, dawn ink
 * type on high-key ones. */
export type GroundFamily = "night" | "dawn";

/** One hue's drawing colours for one family, all solved before this module
 * runs. `safe` stops may sit anywhere including under type; `free` stops may
 * sit only outside the type band, which is where the light source lives. */
export type ResolvedGroundHue = {
  base: string;
  /** Bright slice; index 0 is the brighter of the two on night. */
  free: string[];
  /** The fold colour, per family. */
  lift: string;
  name: string;
  /** Darkest first. */
  safe: [string, string, string];
};

/** mulberry32. Same seed, same field, every render. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Hsl = { h: number; s: number; l: number };

/** Read back the `hsl(h s l%)` strings color.ts emits. */
export function parseHslCss(s: string): Hsl {
  const m = s.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/);
  if (!m) {
    throw new Error(`not an hsl() string: ${s}`);
  }
  return { h: Number(m[1]), l: Number(m[3]), s: Number(m[2]) };
}

const css = (h: number, s: number, l: number): string =>
  `hsl(${h} ${s}% ${l.toFixed(1)}%)`;

/**
 * The accent colour for one coloured word.
 *
 * OpenAI colours exactly one word and leaves the rest white. Which colour that
 * can be falls out of the ground, and both wrong answers are recorded in the
 * launch build: the raw palette hue measured about 2.7:1 on a pale field, and
 * the hue solved against white assumed the ground was white when it is a field
 * that runs darker. So the accent is solved against the darkest value the
 * card's own ground can reach, the floor of its own ramp over every hue the
 * card uses. That makes it safe wherever it lands on that card.
 *
 * On night there is no coloured accent at all: the deep ramp is bounded at
 * 5.8:1 for white, so an accent clearing 4.5:1 against that ground would be
 * near-white, and a near-white accent is not an accent. A coloured word needs
 * a pale ground to sit on, which is why posters carrying one are dawn.
 */
export function accentColor(
  family: GroundFamily,
  hues: ResolvedGroundHue[],
): string {
  if (family !== "dawn" || hues.length === 0) {
    return "#ffffff";
  }
  const floor = Math.min(
    ...hues.map((hue) => luminanceHsl(parseHslCss(hue.safe[0]))),
  );
  const { h, s } = hexToHsl(hues[0].base);
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((floor + 0.05) / (luminanceHsl({ h, l: mid, s }) + 0.05) > 4.8) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return css(h, s, lo);
}

// ---------------------------------------------------------------------------
// The field.
// ---------------------------------------------------------------------------

/** How far past the canvas the blur containers reach, so no blur radius ever
 * samples transparent black at a card edge and darkens it. */
const OVER = 0.4;

type BandSpec = {
  alpha: number;
  angle: number;
  color: string;
  cx: number;
  cy: number;
  len?: number;
  radius?: number;
  thick?: number;
};

type LobeSpec = {
  alpha: number;
  angle: number;
  color: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

/**
 * One oversized rotated band, 2.7 canvases long, so its two short ends are
 * always off-frame and only its long edges cross the picture. That pair of
 * blurred edges is the crease: a rectangle drawn at canvas size would put all
 * four corners in shot and read as a rectangle.
 */
function band(
  spec: BandSpec & { len: number; thick: number },
  w: number,
  h: number,
): string {
  const { angle, alpha, color, cx, cy, len, thick, radius } = spec;
  const left = Math.round(cx * w - len / 2 + OVER * w);
  const top = Math.round(cy * h - thick / 2 + OVER * h);
  return (
    `<div class="band" style="` +
    `width:${Math.round(len)}px;height:${Math.round(thick)}px;` +
    `left:${left}px;top:${top}px;` +
    `background:${color};opacity:${alpha.toFixed(3)};` +
    (radius ? `border-radius:${radius}px;` : "") +
    `transform:rotate(${angle.toFixed(2)}deg)"></div>`
  );
}

/**
 * One oversized ellipse, hard-edged, to be defocused by its container. A
 * hard-edged ellipse thrown far out of focus produces a lobe with a soft but
 * definite boundary, which is what a petal or a fold of fabric looks like
 * through a lens; a radial-gradient blob has no boundary to soften.
 */
function lobe(spec: LobeSpec, w: number, h: number): string {
  const { alpha, angle, color, cx, cy, rx, ry } = spec;
  return (
    `<div class="band" style="` +
    `width:${Math.round(rx * 2)}px;height:${Math.round(ry * 2)}px;` +
    `left:${Math.round(cx * w - rx + OVER * w)}px;top:${Math.round(cy * h - ry + OVER * h)}px;` +
    `background:${color};opacity:${alpha.toFixed(3)};border-radius:50%;` +
    `transform:rotate(${angle.toFixed(2)}deg)"></div>`
  );
}

type FieldOptions = {
  /** Normalised y range bright elements may occupy; undefined means anywhere. */
  band?: [number, number];
  /** Band thickness multiplier, below 1 for layouts with little clear canvas. */
  reach: number;
};

/**
 * Build the field for one card.
 *
 * The references contain one or two large soft lobes of colour with one
 * definite fold running through them, not a rhythm of bars:
 *
 *   mass    one oversized ellipse per hue, hard-edged and thrown far out of
 *           focus, offset to its own side of the axis. Curved, so nothing
 *           about it reads as ruled.
 *   crease  exactly one straight band, running along the axis where the two
 *           masses meet. One fold, not five.
 *   shaft   one broad soft run of light along the shoulder nearest the source,
 *           drawn as an ellipse because nothing in the references has a straight
 *           bright edge in it.
 *   spec    the light source, off-centre.
 *
 * Hue A's mass sits on one side of the axis and hue B's on the other, so the
 * two colours meet along a single seam rather than being stirred together.
 */
function field(
  family: GroundFamily,
  hues: ResolvedGroundHue[],
  rand: () => number,
  w: number,
  h: number,
  opts: FieldOptions,
): { far: string; near: string; spec: string } {
  const typeBand = opts.band;
  const D = Math.max(w, h);
  // One axis for the whole card, kept off square-on and off the diagonal.
  const axis = (14 + rand() * 62) * (rand() < 0.5 ? 1 : -1);
  const rad = (axis * Math.PI) / 180;
  // Unit vector across the axis; masses offset along this land either side of
  // one seam instead of scattering.
  const px = -Math.sin(rad);
  const py = Math.cos(rad);

  // A mass may sit anywhere; a bright element may not sit under the type. Dawn
  // is exempt: its type is ink and every bright element on it is white or
  // paler, so brightness under a dawn headline raises contrast.
  const freeY = (t: number): number => {
    const y = 0.5 + t * 0.62;
    if (!typeBand || family === "dawn") {
      return y;
    }
    return typeBand[0] + ((y + 1) % 1) * (typeBand[1] - typeBand[0]);
  };

  const far: string[] = [];
  const near: string[] = [];

  // Masses. The lead hue takes the darkest, most saturated tone and the
  // largest lobe, so the card reads as one colour at thumbnail size.
  for (const [i, hue] of hues.entries()) {
    const side = i === 0 ? -1 : 1;
    const t = side * (0.2 + rand() * 0.34);
    const rx =
      D * (i === 0 ? 0.72 + rand() * 0.34 : 0.5 + rand() * 0.3) * opts.reach;
    const ry = rx * (0.5 + rand() * 0.45);
    far.push(
      lobe(
        {
          alpha: i === 0 ? 0.95 : 0.72 + rand() * 0.2,
          angle: axis + (rand() - 0.5) * 46,
          color: hue.safe[i === 0 ? 0 : 1],
          cx: 0.5 + t * px + (rand() - 0.5) * 0.16,
          cy: 0.5 + t * py + (rand() - 0.5) * 0.16,
          rx,
          ry,
        },
        w,
        h,
      ),
    );
    // A second, smaller lobe of the same hue one tone lighter, at the near
    // plane: real material has a lit face and a turned one.
    if (i < 2) {
      const r2 = rx * (0.42 + rand() * 0.22);
      near.push(
        lobe(
          {
            alpha: 0.5 + rand() * 0.3,
            angle: axis + (rand() - 0.5) * 70,
            color: hue.safe[i === 0 ? 1 : 2],
            cx: 0.5 + t * px * 1.5 + (rand() - 0.5) * 0.3,
            cy: 0.5 + t * py * 1.5 + (rand() - 0.5) * 0.3,
            rx: r2,
            ry: r2 * (0.55 + rand() * 0.5),
          },
          w,
          h,
        ),
      );
    }
  }

  // The crease. One straight band, 2.7 canvases long. Which focal plane it
  // lands on is seeded, so roughly half the set gets a defined fold and half
  // gets one so soft it only reads as a change of plane.
  const creaseHue = hues[0];
  (rand() < 0.5 ? near : far).push(
    band(
      {
        alpha: family === "dawn" ? 0.5 : 0.4,
        angle: axis + (rand() - 0.5) * 22,
        color: creaseHue.lift,
        cx: 0.5 + (rand() - 0.5) * 0.3,
        cy:
          family === "dawn"
            ? 0.5 + (rand() - 0.5) * 0.34
            : freeY((rand() - 0.5) * 0.8),
        len: D * 2.7,
        radius: D * 0.12,
        thick: D * (0.14 + rand() * 0.2) * opts.reach,
      },
      w,
      h,
    ),
  );

  // The lit shoulder of the fold: an elongated lobe, not a straight run of
  // light. A thin bright band with two parallel edges reads as a ruled line.
  const st = (rand() < 0.5 ? -1 : 1) * (0.16 + rand() * 0.3);
  const shaftHue = hues[hues.length > 1 ? 1 : 0] ?? creaseHue;
  const lx = D * (0.62 + rand() * 0.4) * opts.reach;
  near.push(
    lobe(
      {
        alpha: family === "dawn" ? 0.6 + rand() * 0.22 : 0.32 + rand() * 0.14,
        angle: axis + (rand() - 0.5) * 18,
        color: shaftHue.free[0],
        cx: 0.5 + st * px + (rand() - 0.5) * 0.2,
        cy: freeY(st),
        rx: lx,
        ry: lx * (0.16 + rand() * 0.14),
      },
      w,
      h,
    ),
  );

  // The light source: one off-centre bloom, the brightest thing on the card.
  // Night gets a tight one, because a bloom two canvases wide cannot be
  // confined by moving its centre; dawn can go larger because bright is free.
  const sx = 0.5 + (rand() - 0.5) * 0.9;
  const sy = freeY(rand() < 0.5 ? -0.7 : 0.7);
  const sr = Math.round(
    D *
      (family === "dawn" ? 0.26 + rand() * 0.14 : 0.2 + rand() * 0.1) *
      opts.reach,
  );
  const spec =
    `<div class="spec" style="` +
    `width:${sr * 2}px;height:${sr * 2}px;` +
    `left:${Math.round(sx * w - sr + OVER * w)}px;top:${Math.round(sy * h - sr + OVER * h)}px;` +
    `opacity:${family === "dawn" ? 0.9 : 0.42};` +
    `background:radial-gradient(circle at 50% 50%, ${
      family === "dawn" ? "#ffffff" : "rgba(255,255,255,.85)"
    } 0%, transparent 66%)"></div>`;

  return { far: far.join("\n"), near: near.join("\n"), spec };
}

/** Grain tile size; drawn 1:1 because upscaling is a blur and blurring grain
 * cannot be undone downstream. */
const GRAIN_TILE = 260;

/** Luminance-only film grain. Colour noise tints the ground and pulls hues
 * off-brand; desaturating keeps the grain a texture rather than a filter. The
 * transfer stretches the noise off mid-grey where overlay can act on it. */
const GRAIN = encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='${GRAIN_TILE}' height='${GRAIN_TILE}'>` +
    `<filter id='g'>` +
    `<feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/>` +
    `<feColorMatrix type='saturate' values='0'/>` +
    `<feComponentTransfer>` +
    `<feFuncR type='linear' slope='3.2' intercept='-1.1'/>` +
    `<feFuncG type='linear' slope='3.2' intercept='-1.1'/>` +
    `<feFuncB type='linear' slope='3.2' intercept='-1.1'/>` +
    `</feComponentTransfer>` +
    `</filter>` +
    `<rect width='${GRAIN_TILE}' height='${GRAIN_TILE}' filter='url(#g)'/></svg>`,
);

/**
 * Grain layer opacity per family, measured rather than chosen. The launch
 * build tuned these to sit just above the openai.com reference range
 * (quiet-region RMS 0.14-1.17) while keeping a trace of texture. Dawn runs
 * lower because overlay pushes pale pixels toward white and a pale card has
 * less headroom above it.
 */
export const GRAIN_OPACITY: Record<GroundFamily, number> = {
  dawn: 0.12,
  night: 0.15,
};

/**
 * Where the bright elements of a ground may sit, per layout, as a fraction of
 * canvas height, plus a thickness multiplier. This is a property of the
 * ground: the constraint that keeps the light source out from under a
 * headline.
 */
export const GROUND_BAND: Record<
  string,
  { band: [number, number]; reach: number }
> = {
  float: { band: [0.5, 0.74], reach: 0.46 },
  poster: { band: [0, 0.15], reach: 1 },
  statement: { band: [0, 0.2], reach: 1 },
  wordmark: { band: [0, 0.18], reach: 1 },
};

/**
 * The full-bleed ground for one card. Same slug, same field, every render:
 * the seed is the card slug.
 */
export function atmosphere(
  {
    family,
    hues,
    reach = 1,
    seed,
    band: typeBand,
  }: {
    band?: [number, number];
    family: GroundFamily;
    hues: ResolvedGroundHue[];
    reach?: number;
    seed: string;
  },
  w: number,
  h: number,
): string {
  const rand = rng(seedOf(seed));
  const lead = hues[0];
  if (!lead) {
    throw new Error("atmosphere: no hues");
  }
  const base = lead.safe[family === "night" ? 0 : 1];
  const { far, near, spec } = field(family, hues, rand, w, h, {
    band: typeBand,
    reach,
  });
  // Vignette: night settles the corners so nothing competes with the type,
  // dawn lifts them. A heavy vignette is what made earlier builds read as a
  // panel with a glow on it.
  const vignette =
    family === "night"
      ? `radial-gradient(125% 95% at 50% 40%, rgba(0,0,0,0) 42%, rgba(0,0,0,.42) 100%)`
      : `radial-gradient(125% 95% at 50% 42%, rgba(255,255,255,.12) 0%, rgba(255,255,255,0) 66%)`;
  return `<div class="ground" style="background:${base}">
  <div class="dof far">${far}</div>
  <div class="dof near">${near}</div>
  <div class="dof spec-layer">${spec}</div>
  <div class="vignette" style="background:${vignette}"></div>
  <div class="grain" style="opacity:${GRAIN_OPACITY[family]}"></div>
</div>`;
}

/**
 * CSS the ground needs, injected once per card.
 *
 * Two focal planes, not one: everything in `.far` carries the colour masses
 * far out of focus, `.near` carries creases and shafts at a tighter radius,
 * `.spec-layer` sits between. One radius across the whole field is the tell of
 * a computer-generated background; a real lens has depth. The containers reach
 * 40% past the canvas on every side so no blur radius samples transparent
 * black at an edge.
 */
export const ATMOSPHERE_CSS = `
.ground { position:absolute; inset:0; overflow:hidden; }
.dof { position:absolute; inset:-${OVER * 100}%; }
.far  { filter: blur(168px); }
.near { filter: blur(58px); }
.spec-layer { filter: blur(120px); }
.band { position:absolute; transform-origin:50% 50%; }
.spec { position:absolute; border-radius:50%; }
.vignette { position:absolute; inset:0; }
.grain {
  position:absolute; inset:0;
  background-image:url("data:image/svg+xml,${GRAIN}");
  background-size:${GRAIN_TILE}px ${GRAIN_TILE}px;
  mix-blend-mode:overlay;
  pointer-events:none;
}
`;
