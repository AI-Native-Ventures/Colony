import * as React from "react";

/**
 * Cancelling the autocomplete, and clearing every mention the composer holds.
 *
 * Split out of `useMentions` for the desktop size ratchet. The refs and setters
 * stay owned by the caller; this only sequences them, so the two resets cannot
 * drift apart as either side gains state.
 */
export function useMentionReset({
  autocompleteGenerationRef,
  clearEntityMentions,
  clearMentionIntents,
  debounceTimerRef,
  flushedMentionStartIndexRef,
  mentionMapRef,
  personaMentionMapRef,
  selectedAgentMentionNamesRef,
  selectedAgentMentionPubkeysRef,
  setMentionQuery,
  setMentionSelectedIndex,
  setSelectedAgentMentionNames,
  setSelectedMentionNames,
}: {
  autocompleteGenerationRef: React.RefObject<number>;
  clearEntityMentions: () => void;
  clearMentionIntents: () => void;
  debounceTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  flushedMentionStartIndexRef: React.RefObject<number | null>;
  mentionMapRef: React.RefObject<Map<string, string>>;
  personaMentionMapRef: React.RefObject<Map<string, string>>;
  selectedAgentMentionNamesRef: React.RefObject<string[]>;
  selectedAgentMentionPubkeysRef: React.RefObject<Set<string>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setMentionSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setSelectedAgentMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const cancelMentionAutocomplete = React.useCallback(() => {
    autocompleteGenerationRef.current += 1;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    flushedMentionStartIndexRef.current = null;
    setMentionQuery(null);
    setMentionSelectedIndex(0);
  }, [
    autocompleteGenerationRef,
    debounceTimerRef,
    flushedMentionStartIndexRef,
    setMentionQuery,
    setMentionSelectedIndex,
  ]);

  const clearMentions = React.useCallback(() => {
    cancelMentionAutocomplete();
    mentionMapRef.current.clear();
    personaMentionMapRef.current.clear();
    clearEntityMentions();
    selectedAgentMentionNamesRef.current = [];
    selectedAgentMentionPubkeysRef.current.clear();
    setSelectedMentionNames([]);
    setSelectedAgentMentionNames([]);
    // Belt to the occurrence fence's braces: a paste still verifying when the
    // composer is cleared holds a claim nothing can match afterwards.
    clearMentionIntents();
  }, [
    cancelMentionAutocomplete,
    clearEntityMentions,
    clearMentionIntents,
    mentionMapRef,
    personaMentionMapRef,
    selectedAgentMentionNamesRef,
    selectedAgentMentionPubkeysRef,
    setSelectedAgentMentionNames,
    setSelectedMentionNames,
  ]);

  return { cancelMentionAutocomplete, clearMentions };
}
