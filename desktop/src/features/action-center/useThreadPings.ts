import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { dismissThreadPing } from "@/features/action-center/lib/dismissThreadPing";
import {
  THREAD_PINGS_QUERY_KEY,
  selectAllRootIds,
  selectPingCandidates,
  selectRootIdsNeedingLookup,
  selectUnansweredPings,
  type PingCandidate,
  type ThreadPing,
} from "@/features/action-center/lib/threadPings";
import { addReaction } from "@/shared/api/tauri";
import { relayClient } from "@/shared/api/relayClient";
import {
  buildChannelReactionAuxFilter,
  buildChannelReplyAuxFilter,
} from "@/shared/api/relayChannelFilters";
import { HOME_MENTION_EVENT_KINDS } from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

type ThreadPingData = {
  rootEvents: RelayEvent[];
  replyEvents: RelayEvent[];
  reactionEvents: RelayEvent[];
};

/**
 * Thread-ping detection, wired to live relay data. Three bounded, kinds-
 * scoped queries total for the whole candidate set -- never one per
 * candidate -- because this hook is mounted permanently for the sidebar
 * badge, not only while Action Center is open (see PING_CANDIDATE_LIMIT).
 *
 * Takes `mentions`/`ownerPubkey`/`relaySelfPubkey` as plain values rather
 * than calling useHomeFeedQuery/useIdentityQuery/useRelaySelfQuery itself:
 * useActionCenterItems already mounts all three, and a second mount of the
 * same query key runs its own polling schedule independently of the first
 * (see ActionCenterContext.tsx's doc comment -- this is exactly the
 * double-mount bug that context exists to prevent). Only the three
 * ping-specific queries below are genuinely new.
 */
export function useThreadPings(input: {
  mentions: readonly PingCandidate[];
  ownerPubkey: string | null;
  relaySelfPubkey: string | null;
}): {
  pings: ThreadPing[];
  isLoading: boolean;
  refetch: () => Promise<void>;
  dismiss: (pingId: string) => Promise<void>;
} {
  const { mentions, ownerPubkey, relaySelfPubkey } = input;
  const queryClient = useQueryClient();

  const candidates = React.useMemo<PingCandidate[]>(
    () => selectPingCandidates(mentions),
    [mentions],
  );

  // Keys the data query on the actual candidate set, not on every home-feed
  // poll tick -- most ticks return the same mentions, and re-running the
  // three batched fetches for an unchanged set would be the exact always-on
  // cost this lane must avoid.
  const candidateSetKey = React.useMemo(
    () =>
      candidates
        .map((candidate) => candidate.id)
        .sort()
        .join(","),
    [candidates],
  );

  const dataQuery = useQuery({
    queryKey: [...THREAD_PINGS_QUERY_KEY, candidateSetKey, ownerPubkey ?? ""],
    enabled: ownerPubkey !== null && candidates.length > 0,
    queryFn: async (): Promise<ThreadPingData> => {
      const rootIdsNeedingLookup = selectRootIdsNeedingLookup(candidates);
      const allRootIds = selectAllRootIds(candidates);
      const candidateIds = candidates.map((candidate) => candidate.id);

      const [rootEvents, replyEvents, reactionEvents] = await Promise.all([
        rootIdsNeedingLookup.length > 0
          ? relayClient.fetchEvents({
              ids: rootIdsNeedingLookup,
              kinds: [...HOME_MENTION_EVENT_KINDS],
              limit: rootIdsNeedingLookup.length,
            })
          : Promise.resolve([]),
        relayClient.fetchAuxEventsByReference(
          "",
          allRootIds,
          buildChannelReplyAuxFilter,
        ),
        relayClient.fetchAuxEventsByReference(
          "",
          candidateIds,
          buildChannelReactionAuxFilter,
        ),
      ]);

      return { rootEvents, replyEvents, reactionEvents };
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });

  // Optimistic removal on dismiss (spec: "optimistic removal, reconciled by
  // refetch"), same shape as ActionCenterScreen's resolvingAskIds -- a
  // transient in-memory set, never persisted, reconciled below once the
  // candidate set itself changes underneath it.
  const [dismissedIds, setDismissedIds] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  React.useEffect(() => {
    setDismissedIds((previous) => {
      if (previous.size === 0) return previous;
      const stillCandidateIds = new Set(
        candidates.map((candidate) => candidate.id),
      );
      const next = new Set(
        [...previous].filter((id) => stillCandidateIds.has(id)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [candidates]);

  const pings = React.useMemo(() => {
    if (!ownerPubkey || !dataQuery.data) return [];
    return selectUnansweredPings(candidates, {
      ownerPubkey,
      relaySelfPubkey,
      ...dataQuery.data,
    }).filter((ping) => !dismissedIds.has(ping.id));
  }, [candidates, ownerPubkey, relaySelfPubkey, dataQuery.data, dismissedIds]);

  const dismiss = React.useCallback(
    async (pingId: string) => {
      setDismissedIds((previous) => new Set(previous).add(pingId));
      try {
        await dismissThreadPing(
          { id: pingId },
          {
            addReaction,
            invalidateQueries: (queryKey) =>
              queryClient.invalidateQueries({ queryKey: [...queryKey] }),
          },
        );
      } catch (error) {
        // The reaction never landed -- undo the optimistic hide so the ping
        // reappears rather than silently vanishing from the owner's queue.
        setDismissedIds((previous) => {
          const next = new Set(previous);
          next.delete(pingId);
          return next;
        });
        throw error;
      }
    },
    [queryClient],
  );

  return {
    pings,
    isLoading: dataQuery.isLoading,
    refetch: async () => {
      await dataQuery.refetch();
    },
    dismiss,
  };
}
