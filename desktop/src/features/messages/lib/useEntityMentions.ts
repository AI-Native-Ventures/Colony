import * as React from "react";

import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";

import {
  deleteMentionName,
  routeTypedMentionReferences,
} from "./draftMentionRefs";
import { useBlockMentions } from "./useBlockMentions";
import { useCohortMentions } from "./useCohortMentions";

/**
 * Owns every non-actor entity-mention source (Block, Cohort, ...) behind one
 * interface, so `useMentions` treats "reference an entity" as a single
 * concern instead of repeating block/cohort plumbing at every call site.
 * Adding a third entity kind means adding one more `useXMentions()` call and
 * folding it into `candidates`/`insertSuggestion`/`route` here — not a new
 * touch point in `useMentions.ts`.
 */
export function useEntityMentions(params: {
  channels?: readonly { id: string }[];
  mentionMapRef: React.MutableRefObject<Map<string, string>>;
  personaMentionMapRef: React.MutableRefObject<Map<string, string>>;
  selectedAgentMentionNamesRef: React.MutableRefObject<string[]>;
  setSelectedAgentMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const claimName = React.useCallback(
    (displayName: string) => {
      deleteMentionName(params.mentionMapRef.current, displayName);
      deleteMentionName(params.personaMentionMapRef.current, displayName);
      params.setSelectedAgentMentionNames((current) => {
        const normalizedName = displayName.trim().toLowerCase();
        const next = current.filter(
          (name) => name.trim().toLowerCase() !== normalizedName,
        );
        params.selectedAgentMentionNamesRef.current = next;
        return next;
      });
    },
    [
      params.mentionMapRef,
      params.personaMentionMapRef,
      params.selectedAgentMentionNamesRef,
      params.setSelectedAgentMentionNames,
    ],
  );

  const blockMentions = useBlockMentions({
    channels: params.channels,
    onSelectBlockName: claimName,
    setSelectedNames: params.setSelectedMentionNames,
  });
  const cohortMentions = useCohortMentions({
    onSelectCohortName: claimName,
    setSelectedNames: params.setSelectedMentionNames,
  });

  /** Reclaim a display name from every entity map — an actor mention being
   * inserted under a name a Block or Cohort previously owned. */
  const reclaimName = React.useCallback(
    (name: string) => {
      deleteMentionName(blockMentions.blockMentionMapRef.current, name);
      deleteMentionName(cohortMentions.cohortMentionMapRef.current, name);
    },
    [blockMentions.blockMentionMapRef, cohortMentions.cohortMentionMapRef],
  );

  const clear = React.useCallback(() => {
    blockMentions.clear();
    cohortMentions.clear();
  }, [blockMentions.clear, cohortMentions.clear]);

  const candidates = React.useMemo(
    () => [...blockMentions.candidates, ...cohortMentions.candidates],
    [blockMentions.candidates, cohortMentions.candidates],
  );

  /** Tries each entity source in turn; the first that owns the suggestion wins. */
  const insertSuggestion = React.useCallback(
    (
      suggestion: MentionSuggestion,
    ): { matched: false } | { matched: true; insertText: string } => {
      const blockInsertion = blockMentions.insertSuggestion(suggestion);
      if (blockInsertion.isBlock) {
        return { matched: true, insertText: blockInsertion.insertText };
      }
      const cohortInsertion = cohortMentions.insertSuggestion(suggestion);
      if (cohortInsertion.isCohort) {
        return { matched: true, insertText: cohortInsertion.insertText };
      }
      return { matched: false };
    },
    [blockMentions.insertSuggestion, cohortMentions.insertSuggestion],
  );

  const route = React.useCallback(
    (text: string, actorPubkeys: readonly string[]) =>
      routeTypedMentionReferences(
        text,
        actorPubkeys,
        blockMentions.blockMentionMapRef.current,
        cohortMentions.cohortMentionMapRef.current,
      ),
    [blockMentions.blockMentionMapRef, cohortMentions.cohortMentionMapRef],
  );

  return {
    blockMentionMapRef: blockMentions.blockMentionMapRef,
    cohortMentionMapRef: cohortMentions.cohortMentionMapRef,
    candidates,
    reclaimName,
    clear,
    extractBlockReferenceTags: blockMentions.extractReferenceTags,
    extractCohortReferenceTags: cohortMentions.extractReferenceTags,
    insertSuggestion,
    route,
  };
}
