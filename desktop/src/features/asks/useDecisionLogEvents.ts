import { useQuery } from "@tanstack/react-query";

import {
  decisionLogsQueryKey,
  fetchDecisionLogEvents,
} from "@/features/asks/lib/decisionLog";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The community's decision logs (kind 44303), fetched once and shared.
 *
 * Two surfaces read the same events: the decision log dialog lists them, and
 * delegated authority sums them per grant. They deliberately sit on one query
 * key, so opening the log after the grants list has loaded reuses the cached
 * events rather than refetching, and the two can never disagree about what
 * was decided.
 */
export function useDecisionLogEventsQuery({
  communityId,
  enabled = true,
}: {
  communityId: string;
  /** Extra gate on top of the community check, e.g. "only while open". */
  enabled?: boolean;
}) {
  return useQuery<RelayEvent[]>({
    enabled: communityId !== "" && enabled,
    queryFn: fetchDecisionLogEvents,
    queryKey: decisionLogsQueryKey(communityId),
    staleTime: 30_000,
  });
}
