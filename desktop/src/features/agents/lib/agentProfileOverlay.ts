import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type {
  ChannelMember,
  ManagedAgent,
  RelayAgent,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Overlay managed/relay agent registry names onto a profile lookup.
 *
 * Agent names live in the local registries, not only in relay kind:0 events.
 * An agent can run on a relay that has no kind:0 for it yet (the profile
 * publish happens asynchronously on start and can lag or fail), and any
 * surface that resolves names from the `users-batch` query alone then renders
 * the agent's raw pubkey. Overlaying the registries makes every profile
 * consumer at least as informed as the message timeline, which has always
 * merged these names.
 *
 * A profile-provided displayName wins over the registry name; the registry
 * only fills gaps.
 */
export function mergeAgentNamesIntoProfiles(
  profiles: UserProfileLookup,
  managedAgents: ManagedAgent[],
  relayAgents: RelayAgent[],
  currentPubkey?: string | null,
): UserProfileLookup {
  const merged = { ...profiles };
  for (const agent of relayAgents) {
    const key = normalizePubkey(agent.pubkey);
    merged[key] = {
      ...merged[key],
      displayName: merged[key]?.displayName || agent.name,
      avatarUrl: merged[key]?.avatarUrl ?? null,
      nip05Handle: merged[key]?.nip05Handle ?? null,
      isAgent: true,
    };
  }
  for (const agent of managedAgents) {
    const key = normalizePubkey(agent.pubkey);
    merged[key] = {
      ...merged[key],
      displayName: merged[key]?.displayName || agent.name,
      avatarUrl: merged[key]?.avatarUrl ?? agent.avatarUrl,
      nip05Handle: merged[key]?.nip05Handle ?? null,
      ownerPubkey: merged[key]?.ownerPubkey ?? currentPubkey ?? null,
      isAgent: true,
    };
  }
  return merged;
}

/**
 * Fold channel-member agent flags (`role === "bot"` or `isAgent`) into a
 * profile lookup as `isAgent: true` entries — the same pattern
 * `mergeAgentNamesIntoProfiles` applies to managed/relay agents, extended to
 * the membership signal. Per-pubkey `profiles[pk]?.isAgent` checks
 * (MessageRow's agent predicate) then see member-only bots — agents known
 * through channel membership alone, with no profile flag and no
 * managed/relay/feed presence — without a separate agent-set prop.
 *
 * Returns the input lookup unchanged (same reference) when no member carries
 * an agent flag.
 */
export function mergeMemberAgentFlagsIntoProfiles(
  profiles: UserProfileLookup,
  channelMembers:
    | readonly Pick<ChannelMember, "pubkey" | "role" | "isAgent">[]
    | undefined,
): UserProfileLookup {
  const agentMembers = (channelMembers ?? []).filter(
    (member) => member.role === "bot" || member.isAgent,
  );
  if (agentMembers.length === 0) {
    return profiles;
  }
  const merged = { ...profiles };
  for (const member of agentMembers) {
    const key = normalizePubkey(member.pubkey);
    merged[key] = {
      ...merged[key],
      displayName: merged[key]?.displayName ?? null,
      avatarUrl: merged[key]?.avatarUrl ?? null,
      nip05Handle: merged[key]?.nip05Handle ?? null,
      ownerPubkey: merged[key]?.ownerPubkey ?? null,
      isAgent: true,
    };
  }
  return merged;
}

/**
 * `mergeAgentNamesIntoProfiles` for callers whose inputs may still be
 * loading. Returns the input lookup unchanged (same reference, possibly
 * undefined) when there are no agents to overlay, so query-cache identity is
 * preserved on the common no-agent path.
 */
export function overlayAgentNamesOntoProfiles(
  profiles: UserProfileLookup | undefined,
  managedAgents: ManagedAgent[] | undefined,
  relayAgents: RelayAgent[] | undefined,
  currentPubkey?: string | null,
): UserProfileLookup | undefined {
  if (!managedAgents?.length && !relayAgents?.length) {
    return profiles;
  }
  return mergeAgentNamesIntoProfiles(
    profiles ?? {},
    managedAgents ?? [],
    relayAgents ?? [],
    currentPubkey,
  );
}
