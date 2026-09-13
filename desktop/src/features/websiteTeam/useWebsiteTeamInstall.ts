import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { attachWebsiteManagedAgentToChannel } from "@/features/agents/channelAgents";
import {
  ensureWebsiteCoordinatorReady,
  WebsiteCoordinatorReadinessError,
} from "@/features/websiteIntegration/websiteCoordinatorReadiness";
import {
  managedAgentsQueryKey,
  personasQueryKey,
  relayAgentsQueryKey,
} from "@/features/agents/hooks";
import { teamsQueryKey } from "@/features/agents/teamHooks";
import { channelsQueryKey } from "@/features/channels/hooks";
import { loadActiveCommunityId } from "@/features/communities/communityStorage";
import { useCommunities } from "@/features/communities/useCommunities";
import { getRelayWsUrl, listManagedAgents } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import {
  getWebsiteTeamInstallStatus,
  getWebsiteTeamRecipe,
  installWebsiteTeam,
  type InstallWebsiteTeamResult,
} from "@/shared/api/tauriWebsiteTeam";

import type { AgentStartOutcome } from "./installLogic";
import {
  continueWebsiteTeamInstall,
  type ContinueWebsiteTeamDeps,
} from "./websiteTeamClient";

export type WebsiteTeamInstallRun = {
  result: InstallWebsiteTeamResult;
  starts: AgentStartOutcome[];
};

export type WebsiteTeamInstallInput = {
  channelId: string;
  seedUrl?: string;
  starterPrompt?: string;
};

export function useWebsiteTeamRecipeQuery() {
  return useQuery({
    queryKey: ["website-team-recipe"],
    queryFn: getWebsiteTeamRecipe,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Whether this community already has a journaled install, for an honest
 *  "installing again reconciles" line before the user clicks. */
export function useWebsiteTeamInstallStatusQuery(enabled: boolean) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  return useQuery({
    queryKey: ["website-team-install-status", communityId],
    queryFn: getWebsiteTeamInstallStatus,
    enabled:
      enabled && communityId !== "" && loadActiveCommunityId() === communityId,
    retry: false,
  });
}

function productionDeps(
  expectedCommunityId: string,
  result: InstallWebsiteTeamResult,
): ContinueWebsiteTeamDeps {
  const expectedRelayUrl = result.relayUrl;
  const expectedOwnerPubkey = result.ownerPubkey;

  return {
    expectedCommunityId,
    getActiveCommunityId: loadActiveCommunityId,
    getOwnerPubkey: async () => (await getIdentity()).pubkey,
    getRelayWsUrl,
    listManagedAgents,
    attachAgent: async (channelId, agent) => {
      // The coordinator readiness helper is also the safest start boundary
      // for the other bundled teammates: it preserves provider deployment,
      // uses the explicit relay/owner-fenced local runtime command, and waits
      // for the ACP listening lifecycle instead of treating a spawned process
      // as ready. Its injected attach keeps the membership result for the
      // installer summary while letting the helper choose ensureRunning for
      // local versus provider backends.
      try {
        const attached = await ensureWebsiteCoordinatorReady({
          communityId: expectedCommunityId,
          relayUrl: expectedRelayUrl,
          ownerPubkey: expectedOwnerPubkey,
          channelId,
          coordinatorPubkey: agent.pubkey,
          getActiveCommunityId: loadActiveCommunityId,
          loadManagedAgents: listManagedAgents,
          attachAgent: async (targetChannel, input) => {
            return attachWebsiteManagedAgentToChannel(targetChannel, input, {
              expectedOwnerPubkey,
              expectedRelayUrl,
            });
          },
        });

        return {
          joined: attached.joined,
          newlyAdded: attached.newlyAdded,
          ready: true,
          membershipAdded: attached.membershipAdded,
          // Local readiness always invokes the explicit pair-scoped start
          // command; the generic attachment result only records starts made
          // inside its provider/local helper.
          started: attached.started || attached.agent.backend.type === "local",
        };
      } catch (error) {
        if (error instanceof WebsiteCoordinatorReadinessError) {
          return {
            joined: error.attachment.joined,
            newlyAdded: error.attachment.newlyAdded,
            ready: false,
            membershipAdded: error.attachment.membershipAdded,
            started: false,
            error: error.message,
          };
        }
        throw error;
      }
    },
  };
}

/**
 * Install the team, then add and start its agents in the chosen channel.
 *
 * The mutation deliberately resolves with the real per-teammate start
 * outcomes rather than throwing on a start failure: installation succeeds or
 * fails on its own evidence, and a teammate that needs Power configuration is
 * reported as such with a safe retry.
 */
export function useWebsiteTeamInstallMutation() {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  return useMutation({
    mutationFn: async (
      input: WebsiteTeamInstallInput,
    ): Promise<WebsiteTeamInstallRun> => {
      // `useCommunities` falls back to the first configured community while
      // storage is empty. Setup must fail closed in that state instead of
      // attaching the result to a captured fallback after logout or a switch.
      const expectedCommunityId = loadActiveCommunityId();
      if (!expectedCommunityId || activeCommunity?.id !== expectedCommunityId) {
        throw new Error(
          "Choose an active community before installing the Website Manager team.",
        );
      }
      const result = await installWebsiteTeam({
        channelId: input.channelId,
        seedUrl: input.seedUrl?.trim() || undefined,
        starterPrompt: input.starterPrompt?.trim() || undefined,
      });
      const starts = await continueWebsiteTeamInstall(
        result,
        input.channelId,
        productionDeps(expectedCommunityId, result),
      );
      return { result, starts };
    },
    onSettled: () => {
      for (const queryKey of [
        managedAgentsQueryKey,
        relayAgentsQueryKey,
        personasQueryKey,
        teamsQueryKey,
        channelsQueryKey,
        ["website-team-install-status"],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
