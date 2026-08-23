import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { homeFeedQueryKey } from "@/features/home/hooks";
import {
  appendPendingLiveMention,
  mergePendingLiveMentionsIntoHomeFeed,
  pendingLiveMentionsQueryKey,
} from "@/features/home/lib/liveMentionFeed";
import type {
  Channel,
  FeedItem,
  HomeFeedResponse,
  RelayEvent,
} from "@/shared/api/types";

export function useLiveMentionFeedRepair(
  communityId: string,
  channels: readonly Channel[],
  refetchHomeFeed: () => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  const pendingKey = React.useMemo(
    () => pendingLiveMentionsQueryKey(communityId),
    [communityId],
  );
  // Keep unresolved events observed until the durable projection catches up.
  // The cleanup prevents a prior community from leaking into a later session.
  useQuery<FeedItem[]>({
    queryKey: pendingKey,
    enabled: communityId.length > 0,
    queryFn: () => [],
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  React.useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: pendingKey, exact: true });
    },
    [pendingKey, queryClient],
  );

  return React.useEffectEvent((event: RelayEvent) => {
    if (communityId.length === 0) return;

    const queryKey = homeFeedQueryKey(communityId);
    const currentPending =
      queryClient.getQueryData<FeedItem[]>(pendingKey) ?? [];
    const nextPending = appendPendingLiveMention(
      currentPending,
      event,
      channels,
    );
    if (nextPending === currentPending) return;

    queryClient.setQueryData(pendingKey, nextPending);
    queryClient.setQueryData<HomeFeedResponse>(queryKey, (current) =>
      mergePendingLiveMentionsIntoHomeFeed(current, nextPending),
    );

    // The relay can fan out the committed event before a feed projection
    // read observes it. Every home-feed query reconciles this pending item,
    // so polling, focus, and Inbox refetches cannot erase it while stale.
    void refetchHomeFeed();
  });
}
