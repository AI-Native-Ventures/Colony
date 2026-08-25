import { useQuery } from "@tanstack/react-query";

import {
  listArchivedIdentities,
  type ArchivedIdentitiesSnapshot,
} from "@/shared/api/tauriIdentityArchive";

/**
 * Community-scoped read of the relay's NIP-IA archive snapshot
 * (`kind:13535`, signed by the relay identity; see NIP-IA §Snapshot and
 * Delta Consistency).
 *
 * The Tauri command behind `listArchivedIdentities` talks to whichever
 * relay the backend currently points at, so a read started before a
 * community switch can resolve after it. Bumping `snapshotGeneration` on
 * community switches discards such an in-flight result instead of
 * delivering the old relay's archive list into the new community -- the
 * same guard `fetchManagedAgentHeadEvents` gets from
 * `resetManagedAgentHeadsState`.
 */

let snapshotGeneration = 0;

/** Community-switch reset (see resetCommunityState in useCommunityInit). */
export function resetArchivedIdentitySnapshotState(): void {
  snapshotGeneration += 1;
}

// A discarded mid-switch read must hide nothing, never everything.
const EMPTY_SNAPSHOT: ArchivedIdentitiesSnapshot = { archived: [] };

export async function fetchArchivedIdentitiesSnapshot(): Promise<ArchivedIdentitiesSnapshot> {
  const generation = snapshotGeneration;
  let snapshot: ArchivedIdentitiesSnapshot;
  try {
    snapshot = await listArchivedIdentities();
  } catch (error) {
    if (generation !== snapshotGeneration) return EMPTY_SNAPSHOT;
    throw error;
  }
  if (generation !== snapshotGeneration) {
    // The community switched mid-read; drop everything.
    return EMPTY_SNAPSHOT;
  }
  return snapshot;
}

/** Root shared with identity-archive/hooks.ts: its archive/unarchive
 * mutations invalidate this prefix, so publishing or lifting an archive
 * refreshes every community-scoped snapshot entry too (React Query
 * invalidates by key prefix). */
export const ARCHIVED_IDENTITIES_QUERY_ROOT = "archivedIdentities" as const;

/** Community-scoped key: one community's snapshot never serves another. */
export function archivedIdentitiesSnapshotQueryKey(communityId: string) {
  return [ARCHIVED_IDENTITIES_QUERY_ROOT, communityId] as const;
}

export function useArchivedIdentitiesSnapshotQuery(
  communityId: string,
  enabled = true,
) {
  return useQuery<ArchivedIdentitiesSnapshot>({
    enabled: enabled && communityId !== "",
    queryKey: archivedIdentitiesSnapshotQueryKey(communityId),
    queryFn: fetchArchivedIdentitiesSnapshot,
    staleTime: 30_000,
  });
}
