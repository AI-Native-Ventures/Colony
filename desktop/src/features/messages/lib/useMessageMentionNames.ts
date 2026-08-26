import * as React from "react";

import { useCohortNameByAddress } from "@/features/company/useCohortNameByAddress";
import { resolveCohortMentionNames } from "@/features/messages/lib/resolveCohortMentionNames";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { resolveMentionProps } from "@/shared/lib/resolveMentionNames";

/**
 * A message's highlightable mention names: person aliases from its `p`/
 * `mention` tags, merged with any cohort names its `a`+"cohort" reference
 * tags resolve to through the live catalog. `mentionPubkeysByName` stays
 * person-only — a cohort chip has no pubkey, so it naturally falls back to
 * the markdown renderer's unresolved-mention style.
 */
export function useMessageMentionNames(
  tags: string[][] | undefined,
  profiles: UserProfileLookup | undefined,
) {
  const { mentionNames: actorMentionNames, mentionPubkeysByName } =
    React.useMemo(() => resolveMentionProps(tags, profiles), [tags, profiles]);
  const cohortNameByAddress = useCohortNameByAddress();
  const cohortMentionNames = React.useMemo(
    () => resolveCohortMentionNames(tags, cohortNameByAddress),
    [tags, cohortNameByAddress],
  );
  const mentionNames = React.useMemo(
    () =>
      cohortMentionNames.length > 0
        ? [...new Set([...(actorMentionNames ?? []), ...cohortMentionNames])]
        : actorMentionNames,
    [actorMentionNames, cohortMentionNames],
  );
  return { mentionNames, mentionPubkeysByName };
}
