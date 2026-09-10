import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { ResolvedDiscoveryEntity } from "@/features/discovery/data/DiscoveryDataSource";

import {
  discoveryEntityRefsKey,
  type DiscoveryEntityTagRef,
} from "./discoveryEntityTags";
import { discoveryMessageSource } from "./discoveryMessageSource";

/**
 * The React Query namespace Discovery reads share. `CommunityQueryProvider`
 * builds a fresh client per community, so this key is community-scoped
 * already, and a Discovery write invalidating the whole namespace drops
 * resolved tiles with it.
 */
const DISCOVERY_QUERY_ROOT = "colony-discovery" as const;

/** Long enough that scrolling a thread re-renders nothing, short enough that a
 * lead moved in the Pipeline shows its new status without a reload. */
const RESOLVE_STALE_TIME_MS = 30_000;

const EMPTY: ResolvedDiscoveryEntity[] = [];

export type ResolvedDiscoveryEntities = {
  /** Resolutions in the order the message referenced them. */
  entities: ResolvedDiscoveryEntity[];
  isPending: boolean;
};

/**
 * Resolve one message's Discovery references into current context.
 *
 * One request per message, keyed by the references themselves, so every
 * message mentioning the same entities shares a single resolution. The relay
 * answers in request order; the result is mapped back onto this message's own
 * tag order, because the cache key is sorted and two messages can carry the
 * same entities in different orders.
 */
export function useResolvedDiscoveryEntities(
  refs: readonly DiscoveryEntityTagRef[],
): ResolvedDiscoveryEntities {
  const cacheKey = discoveryEntityRefsKey(refs);
  // The request is sorted so it matches the cache key exactly; without that a
  // hit built from one message's order would be zipped onto another's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cacheKey is the value identity of refs — the array is rebuilt on every render of the row that parsed it, so depending on it directly would recompute forever
  const sortedRefs = React.useMemo(
    () =>
      [...refs].sort((left, right) =>
        `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
      ),
    [cacheKey],
  );
  const source = React.useMemo(() => discoveryMessageSource(), []);
  const query = useQuery({
    queryKey: [DISCOVERY_QUERY_ROOT, "resolved-entities", cacheKey],
    enabled: sortedRefs.length > 0,
    staleTime: RESOLVE_STALE_TIME_MS,
    queryFn: async () => (await source.resolveEntities?.(sortedRefs)) ?? EMPTY,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs is tracked through cacheKey, its value identity, for the same reason as above
  const entities = React.useMemo(() => {
    const resolved = query.data;
    if (!resolved?.length) return EMPTY;
    if (resolved.length !== sortedRefs.length) return resolved;
    const byRef = new Map<string, ResolvedDiscoveryEntity>();
    sortedRefs.forEach((ref, index) => {
      byRef.set(
        `${ref.kind}:${ref.id}`,
        resolved[index] as ResolvedDiscoveryEntity,
      );
    });
    return refs.map(
      (ref) =>
        byRef.get(`${ref.kind}:${ref.id}`) ??
        ({
          resolved: "unavailable",
          kind: ref.kind,
          id: ref.id,
        } satisfies ResolvedDiscoveryEntity),
    );
  }, [cacheKey, query.data, sortedRefs]);

  return {
    entities,
    isPending: sortedRefs.length > 0 && query.isPending,
  };
}
