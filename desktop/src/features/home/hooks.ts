import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  pendingLiveMentionsQueryKey,
  reconcileHomeFeedRead,
} from "@/features/home/lib/liveMentionFeed";
import { getHomeFeed } from "@/shared/api/tauri";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import type { FeedItem } from "@/shared/api/types";
import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";

/** Keeps focused polling at the established 30-second cadence. */
export const HOME_FEED_REFETCH_INTERVAL_MS = 30_000;
/** Suppresses the expensive focus refetch until the home feed is old. */
export const HOME_FEED_FOCUS_STALE_TIME_MS = 5 * 60_000;

/** Focus-refetch policy for the home feed query; consumed by focusRefetchPolicy.test.mjs. */
export const homeFeedFocusRefetchPolicy = {
  staleTime: HOME_FEED_FOCUS_STALE_TIME_MS,
  refetchOnWindowFocus: true,
} as const;

/** Key for the community-scoped Home feed projection. */
export const homeFeedQueryKey = (communityId: string) =>
  ["home-feed", communityId] as const;

export function useHomeFeedQuery() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const connectionState = useRelayConnection();
  const connected = connectionState === "connected";
  const refetchInterval = useFocusedRefetchInterval(
    connected ? HOME_FEED_REFETCH_INTERVAL_MS : false,
  );

  return useQuery({
    queryKey: homeFeedQueryKey(communityId),
    enabled: communityId !== "",
    queryFn: ({ signal }) => {
      const pendingKey = pendingLiveMentionsQueryKey(communityId);
      return reconcileHomeFeedRead({
        readDurable: () =>
          getHomeFeed({
            limit: 50,
            types: "mentions,needs_action,activity,agent_activity",
          }),
        readPending: () =>
          queryClient.getQueryData<FeedItem[]>(pendingKey) ?? [],
        signal,
        writePending: (pending) => {
          queryClient.setQueryData(pendingKey, pending);
        },
      });
    },
    gcTime: 5 * 60 * 1_000,
    // Pause background polling on degraded/stalled/disconnected connections.
    // The relay can't serve the request anyway, and the spurious failures
    // consume quota that the recovery path needs.
    refetchInterval,
    ...homeFeedFocusRefetchPolicy,
  });
}
