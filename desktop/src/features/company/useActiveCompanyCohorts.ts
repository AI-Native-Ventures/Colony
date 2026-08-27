import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";

import type { Cohort } from "./contracts";
import { useCohorts } from "./hooks";

/**
 * The active community's company + its cohorts + the relay-self pubkey
 * needed to build a cohort's NIP-33 coordinate.
 *
 * Shared by the composer's cohort-mention autocomplete
 * (`useCohortMentions`) and the timeline's cohort-mention chip renderer
 * (`useCohortNameByAddress`) so both read the same cached queries instead of
 * duplicating the company/relay-self lookup. `useRelaySelfQuery` (not a
 * one-off fetch) so this shares the app-wide relay-self cache and its
 * community-switch invalidation, the same as every other relay-self reader.
 */
export function useActiveCompanyCohorts(): {
  cohorts: readonly Cohort[];
  relaySelfPubkey: string | null;
} {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const cohortsQuery = useCohorts(communityId, communityId !== "");
  const relaySelfQuery = useRelaySelfQuery(communityId !== "");

  return {
    cohorts: cohortsQuery.data?.ok ? cohortsQuery.data.value : [],
    relaySelfPubkey: relaySelfQuery.data ?? null,
  };
}
