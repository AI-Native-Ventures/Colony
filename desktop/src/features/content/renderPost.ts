/**
 * A post, rendered.
 *
 * This walks one kind-30196 head through the pipeline: card specs out of the
 * post's opaque `style` block, house rules out of the brand kit and the house
 * style, the claim gate out of the verifier, then `renderCard` — which runs
 * the text gates first and only then pays for pixels.
 *
 * The `style` block is opaque to the relay on purpose (`content.rs` says so),
 * which makes this module the one place that decides what it means. The
 * reading is: `slides` is an ordered list of cards, and a post without one is
 * a single card built from the post's own headline. Anything the templates do
 * not recognise is left alone rather than rejected, because a kit may carry
 * fields for a template pack this build has never seen.
 */

import type { ContentPost, CardStyle } from "./contracts";
import type { ContentStyle } from "./contracts";
import type { ClaimGateOutcome } from "./claimVerifier";
import { claimGateResult } from "./claimVerifier";
import type { CardSpec } from "./render/compositions";
import { CANVAS_H, CANVAS_W } from "./render/compositions";
import type { GroundFamily } from "./render/atmosphere";
import type { BrandKit } from "./render/kit";
import { contrastFloor, grainRange } from "./render/kit";
import type { CardText, HouseRules } from "./render/houseStyle";
import type { PipelineOutcome } from "./render/pipeline";
import { renderCard } from "./render/pipeline";
import type { SlideCapture } from "./render/renderSlide";
import { renderSlide } from "./render/renderSlide";

/** The default layout when a post names none. */
const DEFAULT_LAYOUT = "statement";
/** The default ground family when a post names none. */
const DEFAULT_FAMILY: GroundFamily = "night";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFamily(value: unknown, fallback: GroundFamily): GroundFamily {
  return value === "night" || value === "dawn" ? value : fallback;
}

function readHues(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const hues = value.filter(
    (hue): hue is string => typeof hue === "string" && hue.length > 0,
  );
  return hues.length > 0 ? hues : fallback;
}

/**
 * The cards a post draws.
 *
 * Slugs are made unique within the post, because the ground is seeded from the
 * slug: two slides sharing one would render identical pixels, and the pipeline
 * refuses a carousel whose slides share a hash — correctly, but with an error
 * that names hashes rather than the duplicate slug that caused it.
 */
export function cardSpecs(
  post: ContentPost,
  style: CardStyle | null,
): CardSpec[] {
  const family = readFamily(style?.family, DEFAULT_FAMILY);
  const hues = readHues(style?.hues, ["violet"]);
  const layout = style?.layout ?? DEFAULT_LAYOUT;
  const slides = style?.raw.slides;

  const specs: CardSpec[] = [];
  if (Array.isArray(slides) && slides.length > 0) {
    slides.forEach((entry, index) => {
      const slide = isRecord(entry) ? entry : {};
      const headline =
        typeof slide.headline === "string"
          ? slide.headline
          : (post.headline ?? "");
      specs.push({
        accent: typeof slide.accent === "string" ? slide.accent : undefined,
        badge:
          typeof slide.badge === "string"
            ? slide.badge
            : typeof style?.raw.badge === "string"
              ? style.raw.badge
              : undefined,
        family: readFamily(slide.family, family),
        footLine:
          typeof slide.foot_line === "string" ? slide.foot_line : undefined,
        headline,
        hues: readHues(slide.hues, hues),
        layout: typeof slide.layout === "string" ? slide.layout : layout,
        size: typeof slide.size === "number" ? slide.size : undefined,
        slug: `${post.slug}-${index + 1}`,
      });
    });
  } else {
    specs.push({
      badge: typeof style?.raw.badge === "string" ? style.raw.badge : undefined,
      family,
      headline: post.headline ?? "",
      hues,
      layout,
      slug: post.slug,
    });
  }

  for (const spec of specs) {
    if (spec.headline.trim().length === 0) {
      throw new Error(
        `${post.slug}: a card with no headline has nothing to render`,
      );
    }
  }
  return specs;
}

/** Every string the post publishes, drawn or not, for the text gates. */
export function cardText(post: ContentPost, specs: CardSpec[]): CardText {
  const [first, ...rest] = specs;
  return {
    alt: post.alt ?? undefined,
    caption: post.caption ?? undefined,
    extra: [
      ...rest.map((spec) => spec.headline),
      ...specs
        .map((spec) => spec.footLine)
        .filter((line): line is string => typeof line === "string"),
    ],
    headline: first.headline,
  };
}

/**
 * The house rules the pre-render gates measure against.
 *
 * Canvases come from the kit, banned words from the house style's settings.
 * A kit with no canvases still gets the launch canvas, so an unconfigured
 * workspace gates on a real size instead of on nothing.
 */
export function houseRules(
  kit: BrandKit | null,
  style: ContentStyle | null,
): HouseRules {
  const canvases =
    kit && kit.canvases.length > 0
      ? kit.canvases.map((canvas) => ({
          h: canvas.h,
          name: canvas.name,
          w: canvas.w,
        }))
      : [{ h: CANVAS_H, name: "post", w: CANVAS_W }];
  const banned = style?.settings.banned_words;
  return {
    bannedWords: Array.isArray(banned)
      ? banned.filter((word): word is string => typeof word === "string")
      : undefined,
    canvases,
  };
}

export type RenderPostInput = {
  post: ContentPost;
  kit: BrandKit | null;
  style: ContentStyle | null;
  claimGate: ClaimGateOutcome;
  /** The `@font-face` rule for the kit face, from `render/fontKit.ts`. */
  fontFaceCss: string;
  /** ISO timestamp stamped into every report. */
  renderedAt: string;
  /** What rendered this, recorded verbatim in the report. */
  renderer: Record<string, unknown>;
};

export type RenderPostResult = {
  outcome: PipelineOutcome;
  /** The captured slides, empty when the text gates blocked the render. */
  slides: SlideCapture[];
};

/**
 * Render one post and measure every slide.
 *
 * The captured slides are returned alongside the outcome because the caller
 * uploads their bytes: a report names an image hash, and the image whose hash
 * it names has to reach Blossom or the post can never be ready.
 */
export async function renderPost({
  post,
  kit,
  style,
  claimGate,
  fontFaceCss,
  renderedAt,
  renderer,
}: RenderPostInput): Promise<RenderPostResult> {
  const specs = cardSpecs(post, post.style);
  const captured: SlideCapture[] = [];
  const outcome = await renderCard(
    cardText(post, specs),
    CANVAS_W,
    CANVAS_H,
    houseRules(kit, style),
    claimGateResult(claimGate),
    grainRange(kit ?? null),
    async () => {
      for (const spec of specs) {
        // Sequential rather than concurrent: each slide warms the kit face on
        // the shared document and removes it again afterwards, so two running
        // at once would race over the same registration.
        captured.push(
          await renderSlide(spec, { fontFaceCss, kit: kit ?? undefined }),
        );
      }
      return captured;
    },
    renderedAt,
    renderer,
    kit ? contrastFloor(kit) : undefined,
  );
  return { outcome, slides: captured };
}
