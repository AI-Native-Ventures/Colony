import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { useHomeFeedQuery } from "@/features/home/hooks";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import {
  THREAD_PINGS_QUERY_KEY,
  selectAllRootIds,
  selectPingCandidates,
  selectRootIdsNeedingLookup,
  selectUnansweredPings,
  type PingCandidate,
  type ThreadPing,
} from "@/features/action-center/lib/threadPings";
import { useIdentityQuery } from "@/shared/api/hooks";
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
 * Candidates come from the home feed's `mentions` category, already polled
 * on its own 30s cadence by useHomeFeedQuery; this hook adds no new polling
 * of its own and only re-queries reply/reaction state when the candidate set
 * itself changes.
 */
export function useThreadPings(): {
  pings: ThreadPing[];
  isLoading: boolean;
  refetch: () => Promise<void>;
} {
  const identityQuery = useIdentityQuery();
  const ownerPubkey = identityQuery.data?.pubkey ?? null;
  const relaySelfQuery = useRelaySelfQuery();
  const homeFeedQuery = useHomeFeedQuery();

  const candidates = React.useMemo<PingCandidate[]>(() => {
    const mentions = homeFeedQuery.data?.feed.mentions ?? [];
    return selectPingCandidates(mentions);
  }, [homeFeedQuery.data]);

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

  const pings = React.useMemo(() => {
    if (!ownerPubkey || !dataQuery.data) return [];
    return selectUnansweredPings(candidates, {
      ownerPubkey,
      relaySelfPubkey: relaySelfQuery.data ?? null,
      ...dataQuery.data,
    });
  }, [candidates, ownerPubkey, relaySelfQuery.data, dataQuery.data]);

  return {
    pings,
    isLoading: homeFeedQuery.isLoading || dataQuery.isLoading,
    refetch: async () => {
      await dataQuery.refetch();
    },
  };
}
