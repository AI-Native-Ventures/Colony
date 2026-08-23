import type { UserSearchResult } from "@/shared/api/types";

import { parsePubkeyInput } from "@/shared/lib/nostrUtils";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Build a profile-less DM recipient candidate from a pasted hex or npub key.
 *
 * The relay directory only knows users with a kind:0 profile in this
 * community, so a person known only by their key (e.g. a feedback submitter)
 * has no row to select. kind:41010 accepts any 32-byte pubkey, so when the
 * query IS a complete valid key and no candidate already carries it, offer it
 * directly. Returns null when the query is not a complete key or the current
 * user's own key.
 */
export function pubkeyCandidateFromQuery(
  candidates: readonly UserSearchResult[],
  query: string,
  currentPubkey?: string,
): UserSearchResult | null {
  const parsed = parsePubkeyInput(query);
  if (!parsed) {
    return null;
  }
  const pubkey = normalizePubkey(parsed);
  if (currentPubkey && normalizePubkey(currentPubkey) === pubkey) {
    return null;
  }
  if (
    candidates.some((candidate) => normalizePubkey(candidate.pubkey) === pubkey)
  ) {
    return null;
  }
  return {
    avatarUrl: null,
    displayName: null,
    isAgent: false,
    nip05Handle: null,
    ownerPubkey: null,
    pubkey,
  };
}
