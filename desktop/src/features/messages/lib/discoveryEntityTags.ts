import type {
  DiscoveryEntityKind,
  DiscoveryEntityRef,
} from "@/features/discovery/data/DiscoveryDataSource";

import {
  DISCOVERY_MENTION_TAG,
  isDiscoveryMentionKind,
  isValidDiscoveryReference,
} from "./discoveryMentionRefs";

/**
 * The Discovery references a message carries, read back off its tags.
 *
 * The composer and `buzz messages send --discovery` both write one
 * `["discovery", kind, id, label?]` tag per entity. The label is presentation
 * only and is deliberately dropped here: a tile shows the entity's current
 * name as the relay reports it, never the name frozen into a tag by whoever
 * wrote the message.
 */

/** Matches the relay's per-message and per-request reference budget. */
export const DISCOVERY_TILE_MAX_REFS = 20;

export type DiscoveryEntityTagRef = DiscoveryEntityRef;

export function parseDiscoveryEntityTags(
  tags: readonly (readonly string[])[] | undefined,
): DiscoveryEntityTagRef[] {
  if (!tags?.length) return [];
  const seen = new Set<string>();
  const refs: DiscoveryEntityTagRef[] = [];
  for (const tag of tags) {
    if (refs.length >= DISCOVERY_TILE_MAX_REFS) break;
    if (tag[0] !== DISCOVERY_MENTION_TAG) continue;
    if (tag.length !== 3 && tag.length !== 4) continue;
    const kind = tag[1];
    const id = tag[2];
    if (!isDiscoveryMentionKind(kind) || typeof id !== "string") continue;
    const ref = { kind: kind as DiscoveryEntityKind, id };
    if (!isValidDiscoveryReference({ discoveryKind: kind, entityId: id })) {
      continue;
    }
    const dedupeKey = `${kind}:${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push(ref);
  }
  return refs;
}

/**
 * Stable cache identity for a set of references.
 *
 * Sorted, so two messages mentioning the same entities in a different order
 * share one resolution. Render order is restored from each message's own tag
 * order, which is why this can safely ignore it.
 */
export function discoveryEntityRefsKey(
  refs: readonly DiscoveryEntityTagRef[],
): string {
  return refs
    .map((ref) => `${ref.kind}:${ref.id}`)
    .sort()
    .join(",");
}
