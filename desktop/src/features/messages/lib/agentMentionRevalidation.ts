import {
  filterAdmittedMentionPubkeys,
  getAgentMentionAdmission,
  getMentionableAgentPubkeys,
  type AgentEligibilityScope,
} from "@/features/agents/lib/agentAutocompleteEligibility";
import { evictUsersBatchEntries } from "@/features/profile/hooks";
import { getUsersBatch } from "@/shared/api/tauriProfiles";
import { revalidateRelayAgents } from "@/shared/api/tauriRelayAgents";
import type {
  ManagedAgent,
  RelayAgent,
  UsersBatchResponse,
} from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

export type MentionRevalidationOptions = {
  phase?: "prepare" | "publish";
  intendedAgentPubkeys?: readonly string[];
};

export class AgentMentionAuthorizationError extends Error {
  constructor() {
    super(
      "Could not authorize a mentioned agent. Check its access and channel membership, then retry or remove the mention.",
    );
    this.name = "AgentMentionAuthorizationError";
  }
}

type DirectoryResult<T> = {
  data: T | undefined;
  error: Error | null;
};

export async function revalidateAgentMentionPubkeys({
  pubkeys,
  agentPubkeys,
  currentPubkey,
  eligibilityScope,
  sharedChannelIds,
  ownerOnly,
  ownerPolicyError,
  refetchManagedAgents,
  fetchRelayAgents,
  refetchOwnerProfiles,
  phase = "publish",
  intendedAgentPubkeys,
}: {
  phase?: "prepare" | "publish";
  intendedAgentPubkeys?: readonly string[];
  pubkeys: readonly string[];
  agentPubkeys: ReadonlySet<string>;
  currentPubkey: string | null;
  eligibilityScope: AgentEligibilityScope;
  sharedChannelIds: ReadonlySet<string>;
  ownerOnly: boolean | undefined;
  ownerPolicyError: Error | null;
  refetchManagedAgents: () => Promise<DirectoryResult<ManagedAgent[]>>;
  fetchRelayAgents: (pubkeys: string[]) => Promise<RelayAgent[]>;
  refetchOwnerProfiles: (pubkeys: string[]) => Promise<UsersBatchResponse>;
}) {
  const requestedAgentPubkeys = new Set(
    pubkeys.map(normalizePubkey).filter((pubkey) => agentPubkeys.has(pubkey)),
  );
  if (requestedAgentPubkeys.size === 0) {
    return [...pubkeys];
  }

  const [managedResult, relayAgents, ownerProfiles] = await Promise.all([
    refetchManagedAgents(),
    fetchRelayAgents([...requestedAgentPubkeys]).catch(() => null),
    ownerOnly
      ? refetchOwnerProfiles([...requestedAgentPubkeys]).catch(() => null)
      : Promise.resolve(null),
  ]);
  const relayDirectoryReady = relayAgents !== null;
  // A relay-directory failure is deliberately not a hard stop: it empties the
  // relay set, so relay-only agents are denied while fresh managed-agent
  // evidence still stands on its own.
  if (
    ownerOnly === undefined ||
    ownerPolicyError !== null ||
    managedResult.error !== null ||
    managedResult.data === undefined
  ) {
    return filterAdmittedMentionPubkeys(pubkeys, agentPubkeys, new Set());
  }

  const managedPubkeys = new Set(
    managedResult.data.map((agent) => normalizePubkey(agent.pubkey)),
  );
  const mentionablePubkeys = getMentionableAgentPubkeys({
    currentPubkey,
    eligibilityScope,
    phase,
    managedAgentPubkeys: managedPubkeys,
    relayAgents: relayDirectoryReady ? relayAgents : [],
    sharedChannelIds,
  });
  const admittedPubkeys = new Set(
    [...agentPubkeys].filter((pubkey) => {
      const isManagedAgent = managedPubkeys.has(normalizePubkey(pubkey));
      // Readiness is per agent: a managed agent carries its own fresh
      // evidence, while a relay-only one needs both the targeted directory
      // read and, in owner-only builds, the owner proof.
      const directoryReady =
        isManagedAgent ||
        (relayDirectoryReady && (!ownerOnly || ownerProfiles !== null));
      return (
        getAgentMentionAdmission({
          isAgent: true,
          isManagedAgent,
          pubkey,
          ownerPubkey: ownerProfiles?.profiles[pubkey]?.ownerPubkey,
          currentPubkey,
          mentionableAgentPubkeys: mentionablePubkeys,
          directoryReady,
          ownerOnly,
        }) === "allow"
      );
    }),
  );
  // An agent the composer intended to address and that is no longer admitted
  // fails the send loudly instead of publishing a message that silently drops
  // it. Only the intended set raises this: a stale key nobody asked for is
  // still filtered out quietly.
  const intended = (intendedAgentPubkeys ?? []).map(normalizePubkey);
  if (
    intended.some(
      (pubkey) =>
        requestedAgentPubkeys.has(pubkey) && !admittedPubkeys.has(pubkey),
    )
  ) {
    throw new AgentMentionAuthorizationError();
  }
  return filterAdmittedMentionPubkeys(pubkeys, agentPubkeys, admittedPubkeys);
}

export function useAgentMentionRevalidation({
  agentPubkeys,
  getSelectedAgentPubkeys,
  currentPubkey,
  eligibilityScope,
  sharedChannelIds,
  ownerOnly,
  ownerPolicyError,
  refetchManagedAgents,
}: {
  agentPubkeys: ReadonlySet<string>;
  getSelectedAgentPubkeys: () => ReadonlySet<string>;
  currentPubkey: string | null;
  eligibilityScope: AgentEligibilityScope;
  sharedChannelIds: ReadonlySet<string>;
  ownerOnly: boolean | undefined;
  ownerPolicyError: Error | null;
  refetchManagedAgents: () => Promise<DirectoryResult<ManagedAgent[]>>;
}) {
  const queryClient = useQueryClient();
  const refetchOwnerProfiles = React.useCallback(
    async (pubkeys: string[]) => {
      evictUsersBatchEntries(queryClient, pubkeys);
      return getUsersBatch(pubkeys);
    },
    [queryClient],
  );
  return React.useCallback(
    (
      pubkeys: readonly string[],
      destinationChannelId?: string | null,
      options: MentionRevalidationOptions = {},
    ) => {
      // A new DM can acquire its channel during preparation. Validate the
      // actual destination at publication, not the composer's original null id.
      const scope: AgentEligibilityScope = destinationChannelId
        ? { type: "channel", channelId: destinationChannelId }
        : eligibilityScope;
      return revalidateAgentMentionPubkeys({
        pubkeys,
        agentPubkeys: new Set([...agentPubkeys, ...getSelectedAgentPubkeys()]),
        currentPubkey,
        eligibilityScope: scope,
        sharedChannelIds,
        ownerOnly,
        ownerPolicyError,
        refetchManagedAgents,
        fetchRelayAgents: (requestedPubkeys) =>
          revalidateRelayAgents(
            requestedPubkeys,
            "channelId" in scope ? (scope.channelId ?? undefined) : undefined,
          ),
        refetchOwnerProfiles,
        phase: options.phase,
        intendedAgentPubkeys: options.intendedAgentPubkeys,
      });
    },
    [
      agentPubkeys,
      currentPubkey,
      eligibilityScope,
      getSelectedAgentPubkeys,
      ownerOnly,
      ownerPolicyError,
      refetchManagedAgents,
      refetchOwnerProfiles,
      sharedChannelIds,
    ],
  );
}
