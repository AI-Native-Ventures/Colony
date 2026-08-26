import * as React from "react";

import { useActiveCompanyCohorts } from "@/features/company/useActiveCompanyCohorts";
import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import { trimMapToSize } from "@/shared/lib/trimMapToSize";

import {
  type CohortMentionReference,
  extractCohortReferenceTags,
} from "./draftMentionRefs";
import {
  buildCohortMentionCandidates,
  formatCohortMention,
} from "./mentionCandidates";

function appendUniqueName(current: string[], name: string): string[] {
  return current.some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  )
    ? current
    : [...current, name];
}

/**
 * Owns the Cohort-only autocomplete catalog and reference routing state.
 *
 * Mirrors `useBlockMentions` exactly: a cohort mention is a second instance
 * of the same "reference a non-actor entity" mechanism, not a parallel one.
 * Cohorts are inert data (no manifest, no status), so this is the thinner of
 * the two — one catalog read, no recent-usage or workshop handling.
 */
export function useCohortMentions(params: {
  onSelectCohortName: (displayName: string) => void;
  setSelectedNames: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const cohortMentionMapRef = React.useRef<Map<string, CohortMentionReference>>(
    new Map(),
  );
  const { cohorts, relaySelfPubkey } = useActiveCompanyCohorts();

  const candidates = React.useMemo(
    () =>
      relaySelfPubkey
        ? buildCohortMentionCandidates(cohorts, relaySelfPubkey)
        : [],
    [cohorts, relaySelfPubkey],
  );

  const insertSuggestion = React.useCallback(
    (
      suggestion: MentionSuggestion,
    ): { isCohort: false } | { isCohort: true; insertText: string } => {
      if (suggestion.kind !== "cohort") return { isCohort: false };
      const displayName = suggestion.displayName?.trim();
      if (!displayName || !suggestion.cohortAddress) {
        return {
          isCohort: true,
          insertText: `@${suggestion.displayName ?? ""} `,
        };
      }
      params.onSelectCohortName(displayName);
      cohortMentionMapRef.current.set(displayName, {
        cohortAddress: suggestion.cohortAddress,
      });
      trimMapToSize(cohortMentionMapRef.current, 200);
      params.setSelectedNames((current) =>
        appendUniqueName(current, displayName),
      );
      return { isCohort: true, insertText: formatCohortMention(displayName) };
    },
    [params.onSelectCohortName, params.setSelectedNames],
  );

  const clear = React.useCallback(() => {
    cohortMentionMapRef.current.clear();
  }, []);
  const extractReferenceTags = React.useCallback(
    (text: string) =>
      extractCohortReferenceTags(text, cohortMentionMapRef.current),
    [],
  );

  return {
    cohortMentionMapRef,
    candidates,
    clear,
    extractReferenceTags,
    insertSuggestion,
  };
}
