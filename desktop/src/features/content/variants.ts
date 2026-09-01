/**
 * The takes offered when the owner asks to see options.
 *
 * The owner cannot describe what they want, so the system never asks them
 * to: it draws a few takes and they tap the one they like. Each tap is a
 * taste signal recorded on the style record, which is how taste accumulates
 * without anyone writing a sentence.
 *
 * Variation stays inside the knobs the kit already allows: layout among the
 * kit's templates, hue among the kit's hues, ground family. Nothing here
 * invents a look the gates have not measured before.
 */

import type { ContentPost, CardStyle } from "./contracts";
import type { BrandKit } from "./render/kit";

/** Layouts this build can actually draw; mirrors `compositions.LAYOUTS`. */
const DRAWABLE_LAYOUTS = ["statement", "poster"];

export type VariantTake = {
  /** Owner-facing name. Plain words, never design vocabulary. */
  label: string;
  style: CardStyle;
};

function withOverrides(
  base: CardStyle,
  overrides: { family?: string; hues?: string[]; layout?: string },
): CardStyle {
  const family = overrides.family ?? base.family;
  const hues = overrides.hues ?? base.hues;
  const layout = overrides.layout ?? base.layout;
  return {
    family,
    hues,
    layout,
    raw: {
      ...base.raw,
      ...(family !== null ? { family } : {}),
      hues,
      ...(layout !== null ? { layout } : {}),
    },
    variant: base.variant,
  };
}

function sameLook(a: CardStyle, b: CardStyle): boolean {
  return (
    a.family === b.family &&
    a.layout === b.layout &&
    a.hues.join(",") === b.hues.join(",")
  );
}

/**
 * Up to three takes on one post: as drafted, then real alternatives.
 *
 * A carousel varies colour and mood only: its slides may carry per-slide
 * layouts, and flipping the top-level layout under them would change nothing
 * visible, which makes two "takes" identical and the choice meaningless.
 */
export function variantTakes(
  post: ContentPost,
  kit: BrandKit | null,
): VariantTake[] {
  const drafted = post.style;
  if (!drafted) {
    return [];
  }
  const takes: VariantTake[] = [{ label: "As drafted", style: drafted }];
  const isCarousel =
    Array.isArray(drafted.raw.slides) && drafted.raw.slides.length > 0;

  if (!isCarousel) {
    const templates =
      kit && kit.templates.length > 0 ? kit.templates : DRAWABLE_LAYOUTS;
    const currentLayout = drafted.layout ?? "statement";
    const otherLayout = templates.find(
      (template) =>
        template !== currentLayout && DRAWABLE_LAYOUTS.includes(template),
    );
    if (otherLayout) {
      takes.push({
        label: otherLayout === "poster" ? "Bigger" : "Quieter",
        style: withOverrides(drafted, { layout: otherLayout }),
      });
    }
  }

  const currentHue = drafted.hues[0];
  const otherHue = kit?.hues.find((hue) => hue.name !== currentHue);
  if (otherHue) {
    takes.push({
      label: "Different color",
      style: withOverrides(drafted, { hues: [otherHue.name] }),
    });
  } else {
    const flipped = drafted.family === "dawn" ? "night" : "dawn";
    takes.push({
      label: flipped === "dawn" ? "Lighter" : "Darker",
      style: withOverrides(drafted, { family: flipped }),
    });
  }

  const unique: VariantTake[] = [];
  for (const take of takes) {
    if (!unique.some((held) => sameLook(held.style, take.style))) {
      unique.push(take);
    }
  }
  return unique;
}
