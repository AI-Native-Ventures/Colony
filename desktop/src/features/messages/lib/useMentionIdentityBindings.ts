import * as React from "react";

import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { MentionCandidate } from "./mentionCandidates";
import type { MentionIdentity } from "./mentionClipboard";
import {
  useMentionPasteBinding,
  type RegisterMentionPubkey,
} from "./mentionPasteBinding";
import { useVerifyMentionIdentities } from "./useVerifyMentionIdentities";

/**
 * The clipboard side of mention identity: verification of pasted records, the
 * map write a settled paste performs, and the paste-binding claim ledger.
 *
 * Split out of `useMentions` to keep that file under the desktop size ratchet;
 * the hook owns no state of its own beyond what it is handed, so the caller's
 * refs and setters stay the single source of truth.
 */
export function useMentionIdentityBindings({
  appendUniqueMentionName,
  reclaimEntityMentionName,
  mentionCandidates,
  mentionMapRef,
  personaMentionMapRef,
  profiles,
  selectedAgentMentionNamesRef,
  setSelectedAgentMentionNames,
  setSelectedMentionNames,
  trimMapToSize,
}: {
  appendUniqueMentionName: (current: string[], name: string) => string[];
  reclaimEntityMentionName: (name: string) => void;
  mentionCandidates: readonly MentionCandidate[];
  mentionMapRef: React.RefObject<Map<string, string>>;
  personaMentionMapRef: React.RefObject<Map<string, string>>;
  profiles: UserProfileLookup | undefined;
  selectedAgentMentionNamesRef: React.RefObject<string[]>;
  setSelectedAgentMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedMentionNames: React.Dispatch<React.SetStateAction<string[]>>;
  trimMapToSize: (map: Map<string, string>, max: number) => void;
}) {
  // Untrusted clipboard records only become bindable identities once trusted
  // Buzz state confirms the pair — see `mentionIdentityTrust`.
  const verifyMentionIdentities = useVerifyMentionIdentities({
    mentionCandidates,
    profiles,
  });
  // The map write a settled paste uses: it records a decision the user made
  // earlier, so it must not outrank intent expressed since.
  const writeMentionPubkey = React.useCallback<RegisterMentionPubkey>(
    (displayName, pubkey, options) => {
      const trimmedName = displayName.trim();
      if (!trimmedName) {
        return;
      }
      mentionMapRef.current.set(trimmedName, pubkey);
      personaMentionMapRef.current.delete(trimmedName);
      trimMapToSize(mentionMapRef.current, 200);
      setSelectedMentionNames((current) =>
        appendUniqueMentionName(current, trimmedName),
      );
      if (options?.isAgent) {
        selectedAgentMentionNamesRef.current = appendUniqueMentionName(
          selectedAgentMentionNamesRef.current,
          trimmedName,
        );
        setSelectedAgentMentionNames(selectedAgentMentionNamesRef.current);
      }
    },
    [
      appendUniqueMentionName,
      mentionMapRef,
      personaMentionMapRef,
      selectedAgentMentionNamesRef,
      setSelectedAgentMentionNames,
      setSelectedMentionNames,
      trimMapToSize,
    ],
  );
  const pasteBinding = useMentionPasteBinding({
    registerVerifiedMentionPubkey: writeMentionPubkey,
    verifyMentionIdentities,
  });

  // Every caller is explicit user intent — a resolved insert, an agent-address
  // lock, a persona created at send time — so this claims the label before
  // writing it, and a paste still verifying that name settles into nothing.
  const registerMentionPubkey = React.useCallback<RegisterMentionPubkey>(
    (displayName, pubkey, options) => {
      const trimmedName = displayName.trim();
      if (!trimmedName) {
        return;
      }
      reclaimEntityMentionName(trimmedName);
      pasteBinding.claimMentionIntent(trimmedName);
      writeMentionPubkey(trimmedName, pubkey, options);
    },
    [
      pasteBinding.claimMentionIntent,
      reclaimEntityMentionName,
      writeMentionPubkey,
    ],
  );

  return { pasteBinding, registerMentionPubkey, writeMentionPubkey };
}

export type { MentionIdentity, RegisterMentionPubkey };
