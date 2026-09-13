import type {
  ChannelMember,
  ManagedAgent,
  UserSearchResult,
} from "@/shared/api/types";
import { formatMemberName } from "@/features/channels/lib/memberUtils";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/**
 * Pure helpers behind the members dialog: add-candidate labelling, managed-agent
 * metadata, and the roster ordering. Split out of `MembersSidebar.tsx` so that
 * file stays under the desktop file-size ratchet.
 */

export function formatAddCandidateName(user: UserSearchResult) {
  return (
    user.displayName?.trim() ||
    user.nip05Handle?.trim() ||
    truncatePubkey(user.pubkey)
  );
}
export type AddMemberSearchCandidate = UserSearchResult & {
  isManagedAgent?: boolean;
  isMember?: boolean;
  personaId?: string | null;
};
export function addMemberCandidatePersonaId(
  candidate: UserSearchResult,
  managedAgentsByPubkey: ReadonlyMap<string, ManagedAgent>,
) {
  return managedAgentsByPubkey.get(normalizePubkey(candidate.pubkey))
    ?.personaId;
}
export function addMemberCandidateIsManagedAgent(
  candidate: UserSearchResult,
  managedAgentsByPubkey: ReadonlyMap<string, ManagedAgent>,
) {
  return managedAgentsByPubkey.has(normalizePubkey(candidate.pubkey));
}
export function addMemberCandidateWithAgentMetadata(
  candidate: UserSearchResult,
  managedAgentsByPubkey: ReadonlyMap<string, ManagedAgent>,
): AddMemberSearchCandidate {
  return {
    ...candidate,
    isManagedAgent: addMemberCandidateIsManagedAgent(
      candidate,
      managedAgentsByPubkey,
    ),
    personaId: addMemberCandidatePersonaId(candidate, managedAgentsByPubkey),
  };
}

export function memberModalRoleRank(member: ChannelMember) {
  if (member.role === "owner") return 0;
  if (member.role === "admin") return 1;
  return 2;
}
export function compareMembersForModal(
  currentPubkey: string | undefined,
  left: ChannelMember,
  right: ChannelMember,
) {
  const rankDelta = memberModalRoleRank(left) - memberModalRoleRank(right);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  if (currentPubkey && left.pubkey === currentPubkey) return -1;
  if (currentPubkey && right.pubkey === currentPubkey) return 1;

  return formatMemberName(left).localeCompare(formatMemberName(right));
}
