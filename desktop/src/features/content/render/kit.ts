/**
 * The brand kit (kind 30198) as the renderer reads it.
 *
 * The authority for this shape is `crates/buzz-core/src/content_brand_kit.rs`.
 * The relay validates it structurally and stores it verbatim; the renderer is
 * the consumer that interprets it. Nothing here re-decides what a legal kit
 * is: an event that reached storage already passed that parser. What this
 * module does is refuse to render from a kit it cannot read.
 */

export type BrandKitSource =
  | { type: "scan"; url: string; scanned_at?: string }
  | { type: "manual" };

/** One hue with its solved ramp. Ramp order is the kit's business. */
export type BrandHue = {
  name: string;
  base: string;
  ramp: string[];
};

export type BrandKitType = {
  families: string[];
  /** Opaque to the relay; interpreted by the template pack. */
  scale: unknown;
};

export type MarkRole = "logo" | "wordmark" | "icon";

export type BrandMark = {
  role: MarkRole;
  media_hash: string;
  media_url: string;
};

export type BrandCanvas = {
  name: string;
  w: number;
  h: number;
};

export type ClaimStrictness = "strict" | "advisory";

export type BrandKit = {
  id: string;
  source: BrandKitSource;
  hues: BrandHue[];
  type: BrandKitType | null;
  marks: BrandMark[];
  canvases: BrandCanvas[];
  templates: string[];
  rules: {
    claim_strictness: ClaimStrictness;
    contrast_floor: number | null;
    /** Every other rule key, verbatim. */
    raw: Record<string, unknown>;
  };
  version: string;
};

/** The grain gate's range, in quiet-region RMS luminance units (0-255). */
export type GrainRange = { min: number; max: number };

const HEX_COLOR = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;
const SLUG = /^[a-z0-9-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Read a parsed relay event body into a {@link BrandKit}, or return the
 * reasons it was refused. Mirrors the structural checks that matter to the
 * renderer: hues and canvases must resolve, templates must be strings, rules
 * must parse. It does not duplicate the full Rust validation.
 */
export function readBrandKit(raw: unknown): BrandKit {
  if (!isRecord(raw)) {
    throw new Error("brand kit: not an object");
  }
  const id = str(raw.id);
  if (!id || !SLUG.test(id)) {
    throw new Error("brand kit: missing id");
  }
  if (raw.source !== "manual" && !isRecord(raw.source)) {
    throw new Error("brand kit: missing source");
  }

  if (!Array.isArray(raw.hues) || raw.hues.length === 0) {
    throw new Error("brand kit: no hues");
  }
  const hues: BrandHue[] = [];
  for (const entry of raw.hues) {
    if (!isRecord(entry)) {
      throw new Error("brand kit: hue entry is not an object");
    }
    const name = str(entry.name);
    const base = str(entry.base);
    if (!name || !base || !HEX_COLOR.test(base.toLowerCase())) {
      throw new Error(`brand kit: bad hue entry ${JSON.stringify(entry)}`);
    }
    const ramp = Array.isArray(entry.ramp)
      ? entry.ramp.filter(
          (stop): stop is string =>
            typeof stop === "string" && HEX_COLOR.test(stop.toLowerCase()),
        )
      : [];
    hues.push({ base: base.toLowerCase(), name, ramp });
  }

  const kitType = isRecord(raw.type)
    ? {
        families: (Array.isArray(raw.type.families) ? raw.type.families : [])
          .filter((family): family is string => typeof family === "string")
          .map((family) => family.trim())
          .filter((family) => family.length > 0),
        scale: raw.type.scale ?? {},
      }
    : null;
  if (kitType && kitType.families.length === 0) {
    throw new Error("brand kit: type.families is empty");
  }

  const marks: BrandMark[] = [];
  if (Array.isArray(raw.marks)) {
    for (const entry of raw.marks) {
      if (!isRecord(entry)) {
        continue;
      }
      const role = str(entry.role);
      const mediaHash = str(entry.media_hash);
      const mediaUrl = str(entry.media_url);
      if (
        role &&
        mediaHash &&
        mediaUrl &&
        (role === "logo" || role === "wordmark" || role === "icon")
      ) {
        marks.push({ media_hash: mediaHash, media_url: mediaUrl, role });
      }
    }
  }

  if (!Array.isArray(raw.canvases) || raw.canvases.length === 0) {
    throw new Error("brand kit: no canvases");
  }
  const canvases: BrandCanvas[] = [];
  for (const entry of raw.canvases) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = str(entry.name);
    if (
      name &&
      SLUG.test(name) &&
      typeof entry.w === "number" &&
      typeof entry.h === "number"
    ) {
      canvases.push({ h: entry.h, name, w: entry.w });
    }
  }
  if (canvases.length === 0) {
    throw new Error("brand kit: no readable canvases");
  }

  const templates = (Array.isArray(raw.templates) ? raw.templates : []).filter(
    (template): template is string => typeof template === "string",
  );

  const rawRules = isRecord(raw.rules) ? raw.rules : {};
  const strictness = str(rawRules.claim_strictness);
  const claimStrictness: ClaimStrictness =
    strictness === "advisory" ? "advisory" : "strict";
  const floor =
    typeof rawRules.contrast_floor === "number" && rawRules.contrast_floor > 0
      ? rawRules.contrast_floor
      : null;

  return {
    canvases,
    hues,
    id,
    marks,
    rules: {
      claim_strictness: claimStrictness,
      contrast_floor: floor,
      raw: rawRules,
    },
    source:
      raw.source === "manual"
        ? { type: "manual" }
        : (raw.source as BrandKitSource),
    templates,
    type: kitType,
    version: str(raw.version) ?? "",
  };
}

/** Look up one hue by the names other records cite. */
export function hueByName(kit: BrandKit, name: string): BrandHue | null {
  return kit.hues.find((hue) => hue.name === name) ?? null;
}

/** The contrast bar this kit's gates enforce. Defaults to AA body 4.5. */
export function contrastFloor(kit: BrandKit): number {
  return kit.rules.contrast_floor ?? 4.5;
}

/**
 * The grain bar this kit's gates enforce, from `rules.raw.grain` when the
 * kit declares one: `{ min, max }` in quiet-region RMS luminance units.
 * A kit that says nothing — and a workspace with no kit at all — gets the
 * launch build's measured band, so an unconfigured workspace still gates
 * instead of passing everything.
 */
export function grainRange(kit: BrandKit | null): GrainRange {
  const grain = kit?.rules.raw.grain;
  if (isRecord(grain)) {
    const min = typeof grain.min === "number" ? grain.min : null;
    const max = typeof grain.max === "number" ? grain.max : null;
    if (min !== null && max !== null && min < max) {
      return { max, min };
    }
  }
  return { max: 2.6, min: 1.0 };
}
