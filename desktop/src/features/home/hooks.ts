import { useQuery } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import { getHomeFeed } from "@/shared/api/tauri";
import { useRelayConnection } from "@/shared/api/useRelayConnection";

/** Key for the community-scoped Home feed projection. */
export const homeFeedQueryKey = (communityId: string) =>
  ["home-feed", communityId] as const;

export function useHomeFeedQuery() {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const connectionState = useRelayConnection();
  const connected = connectionState === "connected";

  return useQuery({
    queryKey: homeFeedQueryKey(communityId),
    enabled: communityId !== "",
    queryFn: () =>
      getHomeFeed({
        limit: 50,
        types: "mentions,needs_action,activity,agent_activity",
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    // Pause background polling on degraded/stalled/disconnected connections.
    // The relay can't serve the request anyway, and the spurious failures
    // consume quota that the recovery path needs.
    refetchInterval: connected ? 30_000 : false,
  });
}
