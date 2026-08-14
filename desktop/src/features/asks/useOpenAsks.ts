import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  readAsk,
  selectOpenAsks,
  type OpenAsk,
} from "@/features/asks/lib/askEvent";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import {
  KIND_ASK,
  KIND_ASK_RESOLUTION,
  KIND_ASK_WITHDRAWAL,
} from "@/shared/constants/kinds";

const ASK_QUERY_LIMIT = 500;

/** Key for open asks addressed to an owner in one community. */
export function openAsksQueryKey(
  communityId: string,
  ownerPubkey: string | null,
) {
  return ["open-asks", communityId, ownerPubkey] as const;
}

/** Key for closure events corresponding to one community's asks. */
export function askClosuresQueryKey(
  communityId: string,
  askIds: readonly string[],
) {
  return ["open-ask-closures", communityId, askIds] as const;
}

function closureAskIds(events: RelayEvent[] | undefined): string[] {
  return (
    events?.flatMap((event) =>
      event.tags.flatMap((tag) =>
        tag[0] === "e" && typeof tag[1] === "string" ? [tag[1]] : [],
      ),
    ) ?? []
  );
}

/**
 * Read open asks addressed to the current owner and remove asks already named
 * by a resolution or withdrawal event.
 *
 * The relay queries intentionally mirror the Needs-Me surface contract: the
 * first is `#p` over kind 44300, and the second is `#e` over the resulting ask
 * ids. Closure events are filtered by the ask id they name, not by their own
 * event ids.
 */
export function useOpenAsks(): {
  asks: OpenAsk[];
  error: Error | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
} {
  const identityQuery = useIdentityQuery();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const ownerPubkey = identityQuery.data?.pubkey ?? null;
  const connectionState = useRelayConnection();
  const connected = connectionState === "connected";

  const asksQuery = useQuery<RelayEvent[]>({
    enabled: ownerPubkey !== null && communityId !== "",
    queryKey: openAsksQueryKey(communityId, ownerPubkey),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK],
        "#p": [ownerPubkey ?? ""],
        limit: ASK_QUERY_LIMIT,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    // Pause background polling on degraded/stalled/disconnected connections.
    // The relay can't serve the request anyway, and the spurious failures
    // consume quota that the recovery path needs.
    refetchInterval: connected ? 30_000 : false,
  });

  const asks = React.useMemo(
    () =>
      (asksQuery.data ?? []).flatMap((event) => {
        const ask = readAsk(event);
        return ask === null ? [] : [ask];
      }),
    [asksQuery.data],
  );
  const askIds = React.useMemo(() => asks.map((ask) => ask.id), [asks]);

  const closuresQuery = useQuery<RelayEvent[]>({
    enabled: ownerPubkey !== null && communityId !== "" && askIds.length > 0,
    queryKey: askClosuresQueryKey(communityId, askIds),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK_RESOLUTION, KIND_ASK_WITHDRAWAL],
        "#e": askIds,
        limit: ASK_QUERY_LIMIT,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    // Keep closure reads on the same connection-aware polling cadence as the
    // ask read, so an answer disappears promptly after the relay is healthy.
    refetchInterval: connected ? 30_000 : false,
  });

  // Keep the derived list stable while the two query results are unchanged.
  // HomeView feeds this list into its inbox-item memo, so rebuilding it on an
  // unrelated render would force the whole inbox to derive again.
  const openAsks = React.useMemo(
    () => selectOpenAsks(asks, closureAskIds(closuresQuery.data)),
    [asks, closuresQuery.data],
  );

  const refetchAsks = asksQuery.refetch;
  const refetchClosures = closuresQuery.refetch;
  const refetch = React.useCallback(async () => {
    await Promise.all([refetchAsks(), refetchClosures()]);
  }, [refetchAsks, refetchClosures]);
  const error =
    [asksQuery.error, closuresQuery.error].find(
      (cause): cause is Error => cause instanceof Error,
    ) ?? null;

  return {
    asks: openAsks,
    error,
    isLoading:
      identityQuery.isLoading || asksQuery.isLoading || closuresQuery.isLoading,
    refetch,
  };
}
