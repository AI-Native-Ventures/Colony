/**
 * Continue an installed Website Manager team: add each installed agent to the
 * chosen channel and start it, reporting real per-teammate outcomes.
 *
 * All I/O is injected so this orchestrator is unit-testable and so the
 * community guard runs before any relay mutation. Nothing here mints,
 * stores, or returns identity keys.
 */

import type { ManagedAgent } from "@/shared/api/types";
import type {
  InstalledWebsitePersona,
  InstallWebsiteTeamResult,
} from "@/shared/api/tauriWebsiteTeam";

import {
  isInstallCommunityActive,
  looksLikeConfigurationError,
  type AgentStartOutcome,
} from "./installLogic";

export type AttachAgentResult = {
  started: boolean;
  membershipAdded: boolean;
};

export type ContinueWebsiteTeamDeps = {
  getRelayWsUrl: () => Promise<string>;
  listManagedAgents: () => Promise<ManagedAgent[]>;
  attachAgent: (
    channelId: string,
    agent: ManagedAgent,
  ) => Promise<AttachAgentResult>;
};

function normalizePubkey(pubkey: string): string {
  return pubkey.trim().toLowerCase();
}

function outcomeFor(
  persona: InstalledWebsitePersona,
  result: Partial<AgentStartOutcome>,
): AgentStartOutcome {
  return {
    personaId: persona.personaId,
    displayName: persona.displayName,
    pubkey: persona.agentPubkey,
    started: false,
    error: null,
    needsConfiguration: false,
    ...result,
  };
}

/**
 * Add and start every installed teammate in `channelId`, sequentially.
 *
 * - Refuses to touch another community: the install target and the active
 *   community must match, or the call throws before any membership write.
 * - Isolates failures per teammate and keeps going, so one missing Power
 *   configuration does not stop the other three from joining.
 * - Safe to retry: membership and start are both idempotent.
 */
export async function continueWebsiteTeamInstall(
  result: InstallWebsiteTeamResult,
  channelId: string,
  deps: ContinueWebsiteTeamDeps,
): Promise<AgentStartOutcome[]> {
  if (!channelId.trim()) {
    throw new Error("Choose a channel for the Website Manager team.");
  }
  const activeRelay = await deps.getRelayWsUrl();
  if (!isInstallCommunityActive(activeRelay, result)) {
    throw new Error(
      "This team was installed in a different community. Switch back to that community before adding it to a channel.",
    );
  }

  const agents = await deps.listManagedAgents();
  const byPubkey = new Map(
    agents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
  );

  const outcomes: AgentStartOutcome[] = [];
  for (const persona of result.personas) {
    const agent = byPubkey.get(normalizePubkey(persona.agentPubkey));
    if (!agent) {
      outcomes.push(
        outcomeFor(persona, {
          error: `${persona.displayName} was installed but is not in this community's agent list. Retry the installation.`,
        }),
      );
      continue;
    }
    try {
      const attached = await deps.attachAgent(channelId, agent);
      outcomes.push(outcomeFor(persona, { started: attached.started }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not start this teammate.";
      outcomes.push(
        outcomeFor(persona, {
          error: message,
          needsConfiguration: looksLikeConfigurationError(message),
        }),
      );
    }
  }
  return outcomes;
}
