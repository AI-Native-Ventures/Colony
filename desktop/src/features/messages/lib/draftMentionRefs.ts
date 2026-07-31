import type { DraftMentionRef } from "./useDrafts";

import { normalizePubkey } from "@/shared/lib/pubkey";
import { hasMention } from "./hasMention";

export type BlockMentionReference = {
  blockAddress: string;
  manifestId: string;
};

const BLOCK_ADDRESS_RE = /^30178:[0-9a-f]{64}:[a-z][a-z0-9-]{0,63}$/;
const EVENT_ID_RE = /^[0-9a-f]{64}$/;

function normalizeMentionName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

export function deleteMentionName<T>(
  mentions: Map<string, T>,
  displayName: string,
): void {
  const normalizedName = normalizeMentionName(displayName);
  for (const candidate of mentions.keys()) {
    if (normalizeMentionName(candidate) === normalizedName) {
      mentions.delete(candidate);
    }
  }
}

function normalizeBlockReference(
  displayName: string,
  reference: BlockMentionReference,
): DraftMentionRef | null {
  const normalizedName = normalizeMentionName(displayName);
  const blockAddress = reference.blockAddress.trim().toLowerCase();
  const manifestId = reference.manifestId.trim().toLowerCase();
  if (
    !normalizedName ||
    !BLOCK_ADDRESS_RE.test(blockAddress) ||
    !EVENT_ID_RE.test(manifestId) ||
    blockAddress.split(":")[2] !== normalizedName
  ) {
    return null;
  }
  return { displayName: normalizedName, blockAddress, manifestId };
}

export function snapshotDraftMentionRefs(
  content: string,
  mentions: ReadonlyMap<string, string>,
  selectedAgentNames: readonly string[],
  blockMentions: ReadonlyMap<string, BlockMentionReference> = new Map(),
): DraftMentionRef[] {
  const agentNames = new Set(selectedAgentNames.map(normalizeMentionName));
  const blockRefs: DraftMentionRef[] = [];
  const blockOwnedNames = new Set<string>();
  for (const [displayName, reference] of blockMentions) {
    if (!hasMention(content, displayName)) continue;
    const normalized = normalizeBlockReference(displayName, reference);
    if (normalized) {
      blockRefs.push(normalized);
      blockOwnedNames.add(normalizeMentionName(normalized.displayName));
    }
  }
  const actorRefs: DraftMentionRef[] = [...mentions.entries()]
    .filter(
      ([displayName]) =>
        hasMention(content, displayName) &&
        !blockOwnedNames.has(normalizeMentionName(displayName)),
    )
    .map(([displayName, pubkey]) => ({
      displayName,
      pubkey: normalizePubkey(pubkey),
      isAgent: agentNames.has(normalizeMentionName(displayName)),
    }));
  return [...actorRefs, ...blockRefs];
}

function normalizeDraftMentionRefs(
  refs: readonly DraftMentionRef[],
): DraftMentionRef[] {
  const normalized: DraftMentionRef[] = [];
  for (const ref of refs) {
    if ("blockAddress" in ref) {
      const blockRef = normalizeBlockReference(ref.displayName, ref);
      if (blockRef) normalized.push(blockRef);
      continue;
    }
    const displayName = ref.displayName.trim();
    const pubkey = normalizePubkey(ref.pubkey);
    if (displayName && pubkey) {
      normalized.push({ displayName, pubkey, isAgent: ref.isAgent });
    }
  }
  return normalized;
}

export function replaceWithDraftMentionRefs(
  refs: readonly DraftMentionRef[],
  mentions: Map<string, string>,
  personaMentions: Map<string, string>,
  blockMentions: Map<string, BlockMentionReference> = new Map(),
): { names: string[]; agentNames: string[] } {
  mentions.clear();
  personaMentions.clear();
  blockMentions.clear();
  const normalized = normalizeDraftMentionRefs(refs);
  const winningRefs = new Map<string, DraftMentionRef>();
  for (const ref of normalized) {
    winningRefs.set(normalizeMentionName(ref.displayName), ref);
  }
  for (const ref of winningRefs.values()) {
    if ("blockAddress" in ref) {
      blockMentions.set(ref.displayName, {
        blockAddress: ref.blockAddress,
        manifestId: ref.manifestId,
      });
    } else {
      mentions.set(ref.displayName, ref.pubkey);
    }
  }
  const names = [...winningRefs.values()].map((ref) => ref.displayName);
  const agentNames = [...winningRefs.values()]
    .filter((ref) => "isAgent" in ref && ref.isAgent)
    .map((ref) => ref.displayName);
  return { names, agentNames };
}

type ActorMentionCandidate = {
  displayName?: string | null;
  isMember?: boolean;
  pubkey?: string;
};

export function extractTypedActorPubkeys(
  content: string,
  mentions: ReadonlyMap<string, string>,
  candidates: readonly ActorMentionCandidate[],
  blockMentions: ReadonlyMap<string, BlockMentionReference>,
  reservedActorNames: Iterable<string> = [],
): string[] {
  const blockOwnedNames = new Set<string>();
  for (const [displayName, reference] of blockMentions) {
    if (
      hasMention(content, displayName) &&
      normalizeBlockReference(displayName, reference)
    ) {
      blockOwnedNames.add(normalizeMentionName(displayName));
    }
  }
  const selectedDisplayNames = new Set(
    [...mentions.keys(), ...reservedActorNames].map(normalizeMentionName),
  );
  for (const blockName of blockOwnedNames) {
    selectedDisplayNames.add(blockName);
  }

  const pubkeys: string[] = [];
  for (const [displayName, pubkey] of mentions) {
    if (
      !blockOwnedNames.has(normalizeMentionName(displayName)) &&
      hasMention(content, displayName)
    ) {
      pubkeys.push(pubkey);
    }
  }

  for (const candidate of candidates) {
    if (!candidate.pubkey || !candidate.isMember) continue;
    if (pubkeys.includes(candidate.pubkey)) continue;
    const displayName = candidate.displayName;
    if (!displayName) continue;
    if (selectedDisplayNames.has(normalizeMentionName(displayName))) continue;
    if (hasMention(content, displayName)) {
      pubkeys.push(candidate.pubkey);
    }
  }

  return [...new Set(pubkeys)];
}

export function extractBlockReferenceTags(
  content: string,
  blockMentions: ReadonlyMap<string, BlockMentionReference>,
): string[][] {
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const [displayName, reference] of blockMentions) {
    if (!hasMention(content, displayName)) continue;
    const normalized = normalizeBlockReference(displayName, reference);
    if (
      !normalized ||
      !("blockAddress" in normalized) ||
      seen.has(normalized.blockAddress)
    ) {
      continue;
    }
    seen.add(normalized.blockAddress);
    tags.push(["a", normalized.blockAddress, "", "block"]);
  }
  return tags;
}

export function routeTypedMentionReferences(
  content: string,
  actorPubkeys: readonly string[],
  blockMentions: ReadonlyMap<string, BlockMentionReference>,
): { actorPubkeys: string[]; referenceTags: string[][] } {
  return {
    actorPubkeys: [...actorPubkeys],
    referenceTags: extractBlockReferenceTags(content, blockMentions),
  };
}
