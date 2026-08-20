import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { homeFeedQueryKey } from "@/features/home/hooks";
import { mergeLiveMentionsIntoHomeFeed } from "@/features/home/lib/liveMentionFeed";
import type { Channel, HomeFeedResponse, RelayEvent } from "@/shared/api/types";

const PENDING_LIVE_MENTION_LIMIT = 50;

export function useLiveMentionFeedRepair(
  communityId: string,
  channels: readonly Channel[],
  refetchHomeFeed: () => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  const pendingRef = React.useRef<{
    communityId: string;
    events: Map<string, RelayEvent>;
  }>({ communityId: "", events: new Map() });

  return React.useEffectEvent((event: RelayEvent) => {
    if (communityId.length === 0) return;
    if (pendingRef.current.communityId !== communityId) {
      pendingRef.current = { communityId, events: new Map() };
    }

    pendingRef.current.events.set(event.id, event);
    while (pendingRef.current.events.size > PENDING_LIVE_MENTION_LIMIT) {
      const oldestEventId = pendingRef.current.events.keys().next().value;
      if (oldestEventId === undefined) break;
      pendingRef.current.events.delete(oldestEventId);
    }

    const queryKey = homeFeedQueryKey(communityId);
    const repairLiveMentions = () => {
      const pending = pendingRef.current;
      if (pending.communityId !== communityId) return;
      queryClient.setQueryData<HomeFeedResponse>(queryKey, (current) =>
        mergeLiveMentionsIntoHomeFeed(
          current,
          [...pending.events.values()],
          channels,
        ),
      );
    };

    // The relay can fan out the committed event before a feed projection
    // read observes it. Preserve the live event immediately, then repair
    // the cache again after the recheck so a stale response cannot erase it.
    repairLiveMentions();
    void refetchHomeFeed().finally(repairLiveMentions);
  });
}
