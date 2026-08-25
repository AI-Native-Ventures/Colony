import { useQuery } from "@tanstack/react-query";

import type { RelayMember } from "@/shared/api/types";
import { listRelayMembers } from "@/shared/api/relayMembers";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * The community's current owner pubkeys.
 *
 * The relay decides head authorship against its own membership table
 * (`get_relay_member(...).role == "owner"`); the closest client-side read of
 * that table is the NIP-43 membership snapshot `listRelayMembers` parses.
 * Every trust decision in this feature -- which managed-agent heads and
 * which delegation grants are authoritative -- is filtered through this set,
 * so an open relay that publishes no snapshot yields NO trusted heads: fail
 * closed, exactly as the relay would refuse to honor what it cannot verify.
 */
export function ownerPubkeysFromMembers(
  members: readonly RelayMember[],
): Set<string> {
  const owners = new Set<string>();
  for (const member of members) {
    if (member.role === "owner") {
      owners.add(normalizePubkey(member.pubkey));
    }
  }
  return owners;
}

const COMMUNITY_OWNERS_ROOT = "colony-community-owners" as const;

/** Community-scoped query key for the owner pubkey set. */
export function communityOwnersQueryKey(communityId: string) {
  return [COMMUNITY_OWNERS_ROOT, communityId] as const;
}

/**
 * The active community's owner pubkeys, or an empty set while loading (and
 * for relays that publish no membership snapshot). Consumers must treat a
 * still-loading set exactly like an empty one: nothing is trusted yet.
 */
export function useCommunityOwnersQuery(communityId: string, enabled = true) {
  return useQuery({
    queryKey: communityOwnersQueryKey(communityId),
    queryFn: async () => ownerPubkeysFromMembers(await listRelayMembers()),
    enabled: enabled && communityId !== "",
    staleTime: 60_000,
  });
}
