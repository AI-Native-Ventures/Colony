import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { DiscoveryDataSource } from "@/features/discovery/data/DiscoveryDataSource";
import { createFixtureDiscoveryDataSource } from "@/features/discovery/data/FixtureDiscoveryDataSource";
import { createRelayDiscoveryDataSource } from "@/features/discovery/data/RelayDiscoveryDataSource";
import { buildDiscoveryMentionCandidates } from "./mentionCandidates";
import type { DiscoveryMentionCandidate } from "./mentionCandidates";

/**
 * Community-scoped mention search source. `e2e` builds serve taxonomy-only
 * fixture rows so Playwright specs get deterministic candidates without a
 * live relay; every other build searches through the signed Discovery
 * workspace broker like the rest of the app.
 */
function mentionSearchSource(): DiscoveryDataSource | null {
  if (import.meta.env.MODE === "e2e") {
    return createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  }
  let shared = sharedRelaySource;
  if (!shared) {
    shared = createRelayDiscoveryDataSource();
    sharedRelaySource = shared;
  }
  return shared;
}
let sharedRelaySource: DiscoveryDataSource | null = null;

const SEARCH_STALE_TIME_MS = 30_000;
const MIN_QUERY_LENGTH = 2;
/** Bounded results per keystroke; the relay enforces the same cap. */
export const DISCOVERY_MENTION_LIMIT = 10;

/**
 * Debounced, bounded, community-scoped Discovery entity candidates for the
 * composer. Results key off the (debounced) query text, so nothing is
 * preloaded and stale rows for an old query never render.
 */
export function useDiscoveryMentionCandidates(
  mentionQuery: string | null,
): DiscoveryMentionCandidate[] {
  const trimmed = mentionQuery?.trim() ?? "";
  const enabled = mentionQuery !== null && trimmed.length >= MIN_QUERY_LENGTH;
  const search = React.useMemo(() => mentionSearchSource(), []);
  const query = useQuery({
    queryKey: ["discovery-mention-search", trimmed],
    enabled: enabled && search !== null,
    staleTime: SEARCH_STALE_TIME_MS,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const source = (search ?? null) as DiscoveryDataSource | null;
      const rows =
        (await source?.searchEntities?.(trimmed, DISCOVERY_MENTION_LIMIT)) ??
        [];
      return buildDiscoveryMentionCandidates(rows);
    },
  });
  // Only the exact current query's rows are eligible; everything else waits
  // silently rather than flickering the open picker.
  return query.data ?? EMPTY;
}

const EMPTY: DiscoveryMentionCandidate[] = [];
