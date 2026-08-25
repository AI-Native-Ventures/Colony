import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { readAsk, type OpenAsk } from "@/features/asks/lib/askEvent";
import {
  askResolutionsFromEvents,
  pairResolutionsWithAsks,
  type AskResolution,
  type ResolvedAsk,
} from "@/features/asks/lib/askResolution";
import { useCommunities } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import { KIND_ASK, KIND_ASK_RESOLUTION } from "@/shared/constants/kinds";

const ASK_QUERY_LIMIT = 500;
// One screen of recent closures. Resolutions older than this stop being
// listed; the relay keeps every event queryable regardless.
const RESOLUTION_LIMIT = 100;

/** Key for recent kind-44301 resolution events in one community. */
export function askResolutionsQueryKey(communityId: string) {
  return ["ask-resolutions", communityId] as const;
}

/** Key for the resolution naming one specific closed ask. */
export function closedAskResolutionQueryKey(
  communityId: string,
  askId: string | null,
) {
  return ["closed-ask-resolution", communityId, askId] as const;
}

function toOpenAsks(events: RelayEvent[] | undefined): OpenAsk[] {
  return (events ?? []).flatMap((event) => {
    const ask = readAsk(event);
    return ask === null ? [] : [ask];
  });
}

/**
 * Read the community's recent ask resolutions joined with their asks,
 * newest first. Powers surfaces that show how asks CLOSED: a human answer
 * and an executed default must be distinguishable at a glance everywhere
 * both can appear together.
 */
export function useResolvedAsks(): {
  resolvedAsks: ResolvedAsk[];
  isLoading: boolean;
} {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const connectionState = useRelayConnection();
  const connected = connectionState === "connected";

  const resolutionsQuery = useQuery<RelayEvent[]>({
    enabled: communityId !== "",
    queryKey: askResolutionsQueryKey(communityId),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK_RESOLUTION],
        limit: RESOLUTION_LIMIT,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    refetchInterval: connected ? 30_000 : false,
  });

  // Module-level parse helpers keep these memos on plain arrays; no inline
  // selects anywhere near a useQuery.
  const resolutions = React.useMemo(
    () => askResolutionsFromEvents(resolutionsQuery.data ?? []),
    [resolutionsQuery.data],
  );
  const askIds = React.useMemo(() => {
    const seen = new Set<string>();
    for (const resolution of resolutions) {
      if (seen.size >= ASK_QUERY_LIMIT) break;
      seen.add(resolution.askId);
    }
    return [...seen];
  }, [resolutions]);

  const asksQuery = useQuery<RelayEvent[]>({
    enabled: communityId !== "" && askIds.length > 0,
    queryKey: ["resolved-asks", communityId, askIds] as const,
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK],
        ids: askIds,
        limit: ASK_QUERY_LIMIT,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    refetchInterval: connected ? 30_000 : false,
  });

  const asks = React.useMemo(
    () => toOpenAsks(asksQuery.data),
    [asksQuery.data],
  );
  const resolvedAsks = React.useMemo(
    () => pairResolutionsWithAsks(resolutions, asks),
    [asks, resolutions],
  );

  return {
    resolvedAsks,
    isLoading: resolutionsQuery.isLoading || asksQuery.isLoading,
  };
}

/**
 * Read the resolution that closed one specific ask, or null while it is
 * unknown. For the moment a surface is looking at an ask that has just
 * dropped out of the open list and needs to say WHY: who answered it, or
 * whether the deadline passed and the stated default fired instead.
 */
export function useClosedAskResolution(askId: string | null): {
  resolution: AskResolution | null;
  isLoading: boolean;
} {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const query = useQuery<RelayEvent[]>({
    enabled: askId !== null && communityId !== "",
    queryKey: closedAskResolutionQueryKey(communityId, askId),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK_RESOLUTION],
        "#e": [askId ?? ""],
        limit: 5,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
  });

  const resolution = React.useMemo(() => {
    if (!query.data || askId === null) return null;
    return (
      askResolutionsFromEvents(query.data).find(
        (candidate) => candidate.askId === askId,
      ) ?? null
    );
  }, [askId, query.data]);

  return { resolution, isLoading: query.isLoading };
}
