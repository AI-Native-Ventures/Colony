import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { attachManagedAgentToChannel } from "@/features/agents/channelAgents";
import {
  managedAgentsQueryKey,
  personasQueryKey,
  relayAgentsQueryKey,
} from "@/features/agents/hooks";
import { teamsQueryKey } from "@/features/agents/teamHooks";
import { channelsQueryKey } from "@/features/channels/hooks";
import { getRelayWsUrl, listManagedAgents } from "@/shared/api/tauri";
import {
  getWebsiteTeamInstallStatus,
  getWebsiteTeamRecipe,
  installWebsiteTeam,
} from "@/shared/api/tauriWebsiteTeam";

import type { AgentStartOutcome } from "./installLogic";
import {
  continueWebsiteTeamInstall,
  type ContinueWebsiteTeamDeps,
} from "./websiteTeamClient";
import type { InstallWebsiteTeamResult } from "@/shared/api/tauriWebsiteTeam";

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
  return useQuery({
    queryKey: ["website-team-install-status"],
    queryFn: getWebsiteTeamInstallStatus,
    enabled,
    retry: false,
  });
}

function productionDeps(): ContinueWebsiteTeamDeps {
  return {
    getRelayWsUrl,
    listManagedAgents,
    attachAgent: (channelId, agent) =>
      attachManagedAgentToChannel(channelId, {
        agent,
        role: "bot",
        ensureRunning: true,
      }),
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
  return useMutation({
    mutationFn: async (
      input: WebsiteTeamInstallInput,
    ): Promise<WebsiteTeamInstallRun> => {
      const result = await installWebsiteTeam({
        channelId: input.channelId,
        seedUrl: input.seedUrl?.trim() || undefined,
        starterPrompt: input.starterPrompt?.trim() || undefined,
      });
      const starts = await continueWebsiteTeamInstall(
        result,
        input.channelId,
        productionDeps(),
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
