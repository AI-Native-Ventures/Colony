import * as React from "react";

import type { DraftMentionRef } from "./useDrafts";

import { trimMapToSize } from "@/shared/lib/trimMapToSize";
import {
  type BlockMentionReference,
  type CohortMentionReference,
  replaceWithDraftMentionRefs,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs";
import type { DiscoveryMentionReference } from "./discoveryMentionRefs";

export function useDraftMentionRouting(params: {
  mentionMapRef: React.MutableRefObject<Map<string, string>>;
  personaMentionMapRef: React.MutableRefObject<Map<string, string>>;
  blockMentionMapRef: React.MutableRefObject<
    Map<string, BlockMentionReference>
  >;
  cohortMentionMapRef: React.MutableRefObject<
    Map<string, CohortMentionReference>
  >;
  discoveryMentionMapRef: React.MutableRefObject<
    Map<string, DiscoveryMentionReference>
  >;
  selectedAgentNamesRef: React.MutableRefObject<string[]>;
  cancelAutocomplete: () => void;
  setSelectedNames: (names: string[]) => void;
  setSelectedAgentNames: (names: string[]) => void;
}): {
  getDraftMentionRefs: (content: string) => DraftMentionRef[];
  restoreDraftMentionRefs: (refs: readonly DraftMentionRef[]) => void;
} {
  const getDraftMentionRefs = React.useCallback(
    (content: string) =>
      snapshotDraftMentionRefs(
        content,
        params.mentionMapRef.current,
        params.selectedAgentNamesRef.current,
        params.blockMentionMapRef.current,
        params.cohortMentionMapRef.current,
        params.discoveryMentionMapRef.current,
      ),
    [
      params.blockMentionMapRef,
      params.cohortMentionMapRef,
      params.discoveryMentionMapRef,
      params.mentionMapRef,
      params.selectedAgentNamesRef,
    ],
  );
  const restoreDraftMentionRefs = React.useCallback(
    (refs: readonly DraftMentionRef[]) => {
      params.cancelAutocomplete();
      const { names, agentNames } = replaceWithDraftMentionRefs(
        refs,
        params.mentionMapRef.current,
        params.personaMentionMapRef.current,
        params.blockMentionMapRef.current,
        params.cohortMentionMapRef.current,
        params.discoveryMentionMapRef.current,
      );
      trimMapToSize(params.mentionMapRef.current, 200);
      trimMapToSize(params.blockMentionMapRef.current, 200);
      trimMapToSize(params.cohortMentionMapRef.current, 200);
      trimMapToSize(params.discoveryMentionMapRef.current, 200);
      params.selectedAgentNamesRef.current = agentNames;
      params.setSelectedNames(names);
      params.setSelectedAgentNames(agentNames);
    },
    [params],
  );
  return { getDraftMentionRefs, restoreDraftMentionRefs };
}
