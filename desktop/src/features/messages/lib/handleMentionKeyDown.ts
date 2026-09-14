import type * as React from "react";

import type { MentionSuggestion } from "@/features/messages/ui/MentionAutocomplete";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ChannelType } from "@/shared/api/types";
import { flushMentionDebounce, isPlainSpace } from "./flushMentionDebounce";
import type { MentionCandidateWithUI } from "./flushMentionDebounce";

export type MentionKeyDownResult = {
  handled: boolean;
  suggestion?: MentionSuggestion;
};

/**
 * Keyboard handling for the mention dropdown: arrow navigation, Tab/Enter
 * acceptance (flushing a pending debounce first so a fast typist's last
 * keystroke still selects), and Escape.
 *
 * Split out of `useMentions` for the desktop file-size ratchet. Every value it
 * reads is passed in, so the hook keeps ownership of the dependency list.
 */
export function handleMentionKeyDownWith(
  event: React.KeyboardEvent,
  deps: {
    activePersonaIds: Set<string>;
    cancelMentionAutocomplete: () => void;
    candidates: readonly MentionCandidateWithUI[];
    channelType: ChannelType | null | undefined;
    currentPubkey: string | null;
    debounceTimerRef: React.MutableRefObject<ReturnType<
      typeof setTimeout
    > | null>;
    flushedMentionStartIndexRef: React.MutableRefObject<number | null>;
    isMentionOpen: boolean;
    latestCursorRef: React.MutableRefObject<number>;
    latestValueRef: React.MutableRefObject<string>;
    mentionSelectedIndex: number;
    ownerProfiles: UserProfileLookup | undefined;
    profiles: UserProfileLookup | undefined;
    searchableNamesLowerRef: React.MutableRefObject<string[]>;
    setMentionQuery: (value: string | null) => void;
    setMentionSelectedIndex: (update: (current: number) => number) => void;
    suggestions: MentionSuggestion[];
    /** Space inside code must stay literal, so it is never a mention resolve. */
    isCodeContext?: () => boolean;
  },
): MentionKeyDownResult {
  const {
    activePersonaIds,
    cancelMentionAutocomplete,
    candidates,
    channelType,
    currentPubkey,
    debounceTimerRef,
    flushedMentionStartIndexRef,
    isMentionOpen,
    latestCursorRef,
    latestValueRef,
    mentionSelectedIndex,
    ownerProfiles,
    profiles,
    searchableNamesLowerRef,
    setMentionQuery,
    setMentionSelectedIndex,
    suggestions,
    isCodeContext,
  } = deps;
  // Space resolves an exactly typed mention even with the dropdown closed
  // (#6862): the debounce may not have opened it yet, and the reader has
  // already typed the whole name.
  const exactMentionSpace =
    isPlainSpace(event.nativeEvent) && !isCodeContext?.();
  if (!isMentionOpen && !exactMentionSpace) {
    return { handled: false };
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setMentionSelectedIndex((current) =>
      current < suggestions.length - 1 ? current + 1 : 0,
    );
    return { handled: true };
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setMentionSelectedIndex((current) =>
      current > 0 ? current - 1 : suggestions.length - 1,
    );
    return { handled: true };
  }

  if (
    exactMentionSpace ||
    event.key === "Tab" ||
    (event.key === "Enter" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey)
  ) {
    if (debounceTimerRef.current !== null || exactMentionSpace) {
      const flushed = flushMentionDebounce({
        debounceTimerRef,
        latestValueRef,
        latestCursorRef,
        searchableNamesLowerRef,
        candidates,
        activePersonaIds,
        channelType,
        currentPubkey,
        ownerProfiles,
        profiles,
        requireExact: exactMentionSpace,
      });
      // No exact match on Space: the editor keeps the space, nothing resolves.
      if (exactMentionSpace && flushed?.type !== "match") {
        return { handled: false };
      }
      event.preventDefault();
      if (flushed?.type === "match") {
        flushedMentionStartIndexRef.current = flushed.startIndex;
        setMentionQuery(null); // reset so dropdown closes
        return { handled: true, suggestion: flushed.suggestion };
      }
      if (flushed?.type === "no-match") {
        setMentionQuery(null);
        return { handled: true };
      }
    }

    event.preventDefault();
    return { handled: true, suggestion: suggestions[mentionSelectedIndex] };
  }

  if (event.key === "Escape") {
    event.preventDefault();
    cancelMentionAutocomplete(); // full cancel incl. pending debounce
    return { handled: true };
  }

  return { handled: false };
}
