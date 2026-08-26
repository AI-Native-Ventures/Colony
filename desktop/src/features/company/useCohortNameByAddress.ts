import * as React from "react";

import { KIND_COHORT } from "@/shared/constants/kinds";

import { useActiveCompanyCohorts } from "./useActiveCompanyCohorts";

/**
 * Cohort NIP-33 coordinate (`30201:<relay-pubkey>:<id>`) to its current
 * display name, for resolving a message's cohort-mention reference tags
 * (`["a", coordinate, "", "cohort"]`) into the chip text the timeline
 * highlights. The tag carries no display name — a cohort's `d` tag is an
 * opaque id, not a slug like a Block handle — so this is the read-side
 * counterpart to the composer's `buildCohortMentionCandidates`.
 */
export function useCohortNameByAddress(): Record<string, string> {
  const { cohorts, relaySelfPubkey } = useActiveCompanyCohorts();
  return React.useMemo(() => {
    if (!relaySelfPubkey) return {};
    const normalizedRelaySelf = relaySelfPubkey.trim().toLowerCase();
    const map: Record<string, string> = {};
    for (const cohort of cohorts) {
      const name = cohort.name.trim();
      if (!name) continue;
      map[`${KIND_COHORT}:${normalizedRelaySelf}:${cohort.id}`] = name;
    }
    return map;
  }, [cohorts, relaySelfPubkey]);
}
