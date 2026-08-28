/**
 * The handover pack for an approved card.
 *
 * The design deferred publishing ("v1 hands over a pack") and then never built
 * the pack, so an approved card reached nobody: the app had no download and no
 * way to get the words out except selecting them by hand. A card that cannot
 * leave the app is a card that was never published, however well it measured.
 *
 * This is the text half. The image half is `download_image`, which already
 * exists for relay media.
 */

import type { ContentPost } from "./contracts";

/** A filename that survives every platform's rules, and names its slide. */
export function packFilename(
  post: ContentPost,
  slideIndex: number,
  slideCount: number,
): string {
  const safe = post.slug.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "");
  const base = safe.length > 0 ? safe : "card";
  const suffix = slideCount > 1 ? `-${slideIndex + 1}` : "";
  return `${post.scheduledFor}-${base}${suffix}.png`;
}

/**
 * Everything that gets pasted into the posting box, in posting order.
 *
 * Caption first because that is what goes in the box, then the hashtags on
 * their own line the way every platform's composer treats them, then the alt
 * text under a label because it is typed into a different field and pasting it
 * into the caption by accident is the obvious failure.
 *
 * Claims are appended when any are unsourced, as a warning to the person about
 * to publish rather than as part of the copy. A sourced card says nothing here:
 * the gate already passed and repeating it would train the eye to skip the
 * section that matters.
 */
export function postPackText(post: ContentPost): string {
  const parts: string[] = [];
  if (post.caption) {
    parts.push(post.caption);
  }
  if (post.hashtags.length > 0) {
    parts.push(post.hashtags.map((tag) => `#${tag}`).join(" "));
  }
  if (post.alt) {
    parts.push(`Alt text: ${post.alt}`);
  }
  const unsourced = post.claims.filter((claim) => !claim.source);
  if (unsourced.length > 0) {
    parts.push(
      `Unsourced claims, do not publish without checking: ${unsourced
        .map((claim) => `"${claim.asserts}"`)
        .join(", ")}`,
    );
  }
  return parts.join("\n\n");
}
