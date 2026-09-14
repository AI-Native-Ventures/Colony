import type { MentionCandidate } from "./mentionCandidates";
import type { MentionIdentity } from "./mentionClipboard";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * The identity records a copy carries: every label the composer can currently
 * resolve to a pubkey, picked mentions first.
 *
 * Split out of `useMentions` for the desktop size ratchet. Pure, so a spec can
 * drive it without a composer.
 */
export function collectMentionIdentities({
  knownAgentPubkeys,
  mentionCandidates,
  mentionMap,
  selectedAgentMentionNames,
}: {
  knownAgentPubkeys: ReadonlySet<string>;
  mentionCandidates: readonly MentionCandidate[];
  mentionMap: ReadonlyMap<string, string>;
  selectedAgentMentionNames: readonly string[];
}): MentionIdentity[] {
  const agentNames = new Set(
    selectedAgentMentionNames.map((name) => name.trim().toLowerCase()),
  );
  const identities: MentionIdentity[] = [];
  const claimed = new Set<string>();
  const add = (label: string, pubkey: string, isAgent: boolean) => {
    const trimmed = label.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || !pubkey || claimed.has(key)) return;
    claimed.add(key);
    identities.push({ isAgent, label: trimmed, pubkey });
  };
  // Explicitly picked mentions first: they are authoritative when a manually
  // typed member name collides with one the user selected from the picker.
  for (const [label, pubkey] of mentionMap) {
    add(label, pubkey, agentNames.has(label.trim().toLowerCase()));
  }
  for (const candidate of mentionCandidates) {
    if (
      candidate.kind === "block" ||
      candidate.kind === "cohort" ||
      candidate.kind === "discovery"
    ) {
      continue;
    }
    if (!candidate.isMember || !candidate.pubkey || !candidate.displayName) {
      continue;
    }
    add(
      candidate.displayName,
      candidate.pubkey,
      knownAgentPubkeys.has(normalizePubkey(candidate.pubkey)),
    );
  }
  return identities;
}
