import * as React from "react";

import { useBlockCatalogQuery } from "@/features/blocks/blockCatalog";
import { useCommunities } from "@/features/communities/useCommunities";
import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import { trimMapToSize } from "@/shared/lib/trimMapToSize";

import {
  type BlockMentionReference,
  extractBlockReferenceTags,
  routeTypedMentionReferences,
} from "./draftMentionRefs";
import {
  buildBlockMentionCandidates,
  formatBlockMention,
} from "./mentionCandidates";

function appendUniqueName(current: string[], name: string): string[] {
  return current.some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  )
    ? current
    : [...current, name];
}

/** Owns the Block-only autocomplete catalog and reference routing state. */
export function useBlockMentions(params: {
  channels?: readonly { id: string }[];
  onSelectBlockName: (displayName: string) => void;
  setSelectedNames: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const blockMentionMapRef = React.useRef<Map<string, BlockMentionReference>>(
    new Map(),
  );
  const { activeCommunity } = useCommunities();
  const catalogRequest = React.useMemo(
    () =>
      activeCommunity
        ? {
            communityId: activeCommunity.id,
            channelIds: (params.channels ?? []).map((channel) => channel.id),
          }
        : null,
    [activeCommunity, params.channels],
  );
  const catalogQuery = useBlockCatalogQuery(catalogRequest);
  const candidates = React.useMemo(
    () => buildBlockMentionCandidates(catalogQuery.data ?? []),
    [catalogQuery.data],
  );

  const insertSuggestion = React.useCallback(
    (
      suggestion: MentionSuggestion,
    ): { isBlock: false } | { isBlock: true; insertText: string } => {
      if (suggestion.kind !== "block") return { isBlock: false };
      const blockHandle = suggestion.blockHandle?.trim().toLowerCase();
      if (!blockHandle || !suggestion.blockAddress || !suggestion.manifestId) {
        return {
          isBlock: true,
          insertText: `@${suggestion.displayName} `,
        };
      }
      params.onSelectBlockName(blockHandle);
      blockMentionMapRef.current.set(blockHandle, {
        blockAddress: suggestion.blockAddress,
        manifestId: suggestion.manifestId,
      });
      trimMapToSize(blockMentionMapRef.current, 200);
      params.setSelectedNames((current) =>
        appendUniqueName(current, blockHandle),
      );
      return { isBlock: true, insertText: formatBlockMention(blockHandle) };
    },
    [params.onSelectBlockName, params.setSelectedNames],
  );

  const clear = React.useCallback(() => {
    blockMentionMapRef.current.clear();
  }, []);
  const extractReferenceTags = React.useCallback(
    (text: string) =>
      extractBlockReferenceTags(text, blockMentionMapRef.current),
    [],
  );
  const routeReferences = React.useCallback(
    (text: string, actorPubkeys: readonly string[]) =>
      routeTypedMentionReferences(
        text,
        actorPubkeys,
        blockMentionMapRef.current,
      ),
    [],
  );

  return {
    blockMentionMapRef,
    candidates,
    clear,
    extractReferenceTags,
    insertSuggestion,
    routeReferences,
  };
}
