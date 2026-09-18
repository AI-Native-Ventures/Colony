/**
 * Colony's recommended fallback chain for the active community's relay.
 *
 * Shared by the global Agent defaults field and the per-agent one so both read
 * the same cache with the same retry: a cold cache answers with an empty list
 * and schedules its own refresh, so asking again a few seconds later is the
 * difference between showing an owner their community's chain and showing them
 * nothing at all.
 */
import { useQuery } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import { getRecommendedModelChain } from "@/shared/api/tauriGlobalAgentConfig";

const RECOMMENDED_CHAIN_RETRY_MS = 3000;

export function useRecommendedModelChain(enabled: boolean): string[] {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const query = useQuery({
    enabled: enabled && relayUrl.length > 0,
    queryFn: () => getRecommendedModelChain(relayUrl),
    queryKey: ["recommendedModelChain", relayUrl],
    refetchInterval: (state) =>
      (state.state.data?.length ?? 0) === 0
        ? RECOMMENDED_CHAIN_RETRY_MS
        : false,
  });
  return query.data ?? [];
}
