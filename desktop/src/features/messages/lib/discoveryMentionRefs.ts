import { hasMention } from "./hasMention";

/**
 * Structured Discovery references: one `["discovery", kind, id, label]` tag
 * per mentioned entity, mirroring the buzz-core `DiscoveryEntityRef`
 * contract. The label is presentation only; kind + id are authoritative and
 * are what a receiving agent resolves into current context.
 */

export const DISCOVERY_MENTION_TAG = "discovery";

export const DISCOVERY_MENTION_KINDS = [
  "industry",
  "vertical",
  "campaign",
  "campaign_leads",
  "lead",
  "run",
] as const;

export type DiscoveryMentionKind = (typeof DISCOVERY_MENTION_KINDS)[number];

export type DiscoveryMentionReference = {
  discoveryKind: DiscoveryMentionKind;
  entityId: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAXONOMY_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** Verticals repeat across industries, so their stable ID composes
 * `<industry-id>/<vertical-id>` exactly like buzz-core validates it. */
export function splitVerticalEntityId(
  entityId: string,
): { industryId: string; verticalId: string } | null {
  const parts = entityId.split("/");
  if (parts.length !== 2) return null;
  const [industryId, verticalId] = parts;
  if (!TAXONOMY_ID_RE.test(industryId ?? "")) return null;
  if (!TAXONOMY_ID_RE.test(verticalId ?? "")) return null;
  return { industryId: industryId as string, verticalId: verticalId as string };
}

export function isValidDiscoveryReference(
  reference: DiscoveryMentionReference,
): boolean {
  if (
    !DISCOVERY_MENTION_KINDS.includes(reference.discoveryKind) ||
    typeof reference.entityId !== "string"
  ) {
    return false;
  }
  switch (reference.discoveryKind) {
    case "industry":
      return TAXONOMY_ID_RE.test(reference.entityId);
    case "vertical":
      return splitVerticalEntityId(reference.entityId) !== null;
    default:
      return UUID_RE.test(reference.entityId);
  }
}

/** Validate a selected suggestion's reference; mirrors the Rust validator so
 * an invalid structured tag can never leave the composer. */
export function normalizeDiscoveryMention(
  displayName: string,
  reference: DiscoveryMentionReference,
): ({ displayName: string } & DiscoveryMentionReference) | null {
  const normalized = displayName.trim();
  const entityId = reference.entityId.trim();
  if (!normalized || !entityId) return null;
  const validated: DiscoveryMentionReference = {
    discoveryKind: reference.discoveryKind,
    entityId,
  };
  if (!isValidDiscoveryReference(validated)) return null;
  return { displayName: normalized, ...validated };
}

export function isDiscoveryMentionKind(
  value: unknown,
): value is DiscoveryMentionKind {
  return (
    typeof value === "string" &&
    DISCOVERY_MENTION_KINDS.includes(value as DiscoveryMentionKind)
  );
}

/**
 * One `discovery` tag per distinct (kind, id), in insertion order. Names the
 * composer let people read travel as the final tag element only.
 */
export function extractDiscoveryReferenceTags(
  content: string,
  mentions: ReadonlyMap<string, DiscoveryMentionReference>,
): string[][] {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const [displayName, reference] of mentions) {
    if (!hasMention(content, displayName)) continue;
    const normalized = normalizeDiscoveryMention(displayName, reference);
    if (!normalized) continue;
    const dedupKey = `${normalized.discoveryKind}:${normalized.entityId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    tags.push([
      DISCOVERY_MENTION_TAG,
      normalized.discoveryKind,
      normalized.entityId,
      normalized.displayName,
    ]);
  }
  return tags;
}
