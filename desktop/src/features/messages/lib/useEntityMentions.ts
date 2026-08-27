import * as React from "react";

import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import { trimMapToSize } from "@/shared/lib/trimMapToSize";

import {
  normalizeDiscoveryMention,
  type DiscoveryMentionReference,
} from "./discoveryMentionRefs";
import { extractDiscoveryReferenceTags } from "./discoveryMentionRefs";
import { useBlockMentions } from "./useBlockMentions";
import { useCohortMentions } from "./useCohortMentions";
import {
  deleteMentionName,
  routeTypedMentionReferences,
} from "./draftMentionRefs";
import { useDiscoveryMentionCandidates } from "./useDiscoveryMentions";

/**
 * Owns every non-actor entity-mention source (Block, Cohort, Discovery, ...)
 * behind one interface, so `useMentions` treats "reference an entity" as a
 * single concern instead of repeating block/cohort/discovery plumbing at
 * every call site. Adding a fourth entity kind means adding one more hook
 * call and folding it into `candidates`/`insertSuggestion`/`route` here —
 * not a new touch point in `useMentions.ts`.
 */
export function useEntityMentions(params: {
  channels?: readonly { id: string }[];
  mentionQuery: string | null;
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

  const discoveryMentionMapRef = React.useRef<
    Map<string, DiscoveryMentionReference>
  >(new Map());
  const discoveryCandidates = useDiscoveryMentionCandidates(
    params.mentionQuery,
  );

  const insertDiscoverySuggestion = React.useCallback(
    (
      suggestion: MentionSuggestion,
    ): { matched: false } | { matched: true; insertText: string } => {
      if (suggestion.kind !== "discovery") return { matched: false };
      const displayName = suggestion.displayName.trim();
      if (!displayName || !suggestion.discoveryKind || !suggestion.entityId) {
        return {
          matched: true,
          insertText: `@${suggestion.displayName ?? ""} `,
        };
      }
      const normalized = normalizeDiscoveryMention(displayName, {
        discoveryKind: suggestion.discoveryKind,
        entityId: suggestion.entityId,
      });
      // An unnormalized reference still inserts readable text; it just never
      // produces a structured tag on send.
      if (!normalized) {
        return { matched: true, insertText: `@${displayName} ` };
      }
      claimName(normalized.displayName);
      discoveryMentionMapRef.current.set(normalized.displayName, {
        discoveryKind: normalized.discoveryKind,
        entityId: normalized.entityId,
      });
      trimMapToSize(discoveryMentionMapRef.current, 200);
      return {
        matched: true,
        insertText: `@${normalized.displayName} `,
      };
    },
    [claimName],
  );

  /** Reclaim a display name from every entity map — an actor mention being
   * inserted under a name a Block, Cohort, or Discovery entity owned. */
  const reclaimName = React.useCallback(
    (name: string) => {
      deleteMentionName(blockMentions.blockMentionMapRef.current, name);
      deleteMentionName(cohortMentions.cohortMentionMapRef.current, name);
      deleteMentionName(discoveryMentionMapRef.current, name);
    },
    [blockMentions.blockMentionMapRef, cohortMentions.cohortMentionMapRef],
  );

  const clear = React.useCallback(() => {
    blockMentions.clear();
    cohortMentions.clear();
    discoveryMentionMapRef.current.clear();
  }, [blockMentions.clear, cohortMentions.clear]);

  const candidates = React.useMemo(
    () => [
      ...blockMentions.candidates,
      ...cohortMentions.candidates,
      ...discoveryCandidates,
    ],
    [blockMentions.candidates, cohortMentions.candidates, discoveryCandidates],
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
      return insertDiscoverySuggestion(suggestion);
    },
    [
      blockMentions.insertSuggestion,
      cohortMentions.insertSuggestion,
      insertDiscoverySuggestion,
    ],
  );

  const route = React.useCallback(
    (text: string, actorPubkeys: readonly string[]) =>
      routeTypedMentionReferences(
        text,
        actorPubkeys,
        blockMentions.blockMentionMapRef.current,
        cohortMentions.cohortMentionMapRef.current,
        discoveryMentionMapRef.current,
      ),
    [blockMentions.blockMentionMapRef, cohortMentions.cohortMentionMapRef],
  );

  return {
    blockMentionMapRef: blockMentions.blockMentionMapRef,
    cohortMentionMapRef: cohortMentions.cohortMentionMapRef,
    discoveryMentionMapRef,
    candidates,
    reclaimName,
    clear,
    extractBlockReferenceTags: blockMentions.extractReferenceTags,
    extractCohortReferenceTags: cohortMentions.extractReferenceTags,
    extractDiscoveryReferenceTags: (text: string) =>
      extractDiscoveryReferenceTags(text, discoveryMentionMapRef.current),
    insertSuggestion,
    route,
  };
}
