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
  /** The agent is confirmed in the channel, including an idempotent retry. */
  joined: boolean;
  /** The current attempt added the agent; false when it was already present. */
  newlyAdded: boolean;
  /** The runtime reached the readiness boundary used by Website actions. */
  ready: boolean;
  started: boolean;
  /** Kept as a wire-compatible alias for older callers. */
  membershipAdded: boolean;
  /** A non-fatal runtime error after membership was established. */
  error?: string | null;
};

export type ContinueWebsiteTeamDeps = {
  /** Community captured before the native install began. */
  expectedCommunityId: string;
  /** Read the persisted active community; a missing value fails closed. */
  getActiveCommunityId: () => string | null;
  /** Read the current account identity without exposing its secret key. */
  getOwnerPubkey: () => Promise<string>;
  getRelayWsUrl: () => Promise<string>;
  listManagedAgents: () => Promise<ManagedAgent[]>;
  attachAgent: (
    channelId: string,
    agent: ManagedAgent,
  ) => Promise<AttachAgentResult>;
};

const HEX_64 = /^[0-9a-f]{64}$/;

function assertScopeIdentity(value: string, label: string): string {
  const normalized = normalizePubkey(value);
  if (!HEX_64.test(normalized)) {
    throw new Error(`The installed Website Manager ${label} is invalid.`);
  }
  return normalized;
}

/**
 * Check every scope component immediately before and after an awaited read or
 * write. The native install is active-community scoped, while the channel
 * attachment API reads its own active context; checking both here prevents a
 * community/account switch during an await from attaching the returned agents
 * to the wrong relay.
 */
async function assertCurrentScope(
  result: InstallWebsiteTeamResult,
  deps: ContinueWebsiteTeamDeps,
): Promise<void> {
  if (
    !deps.expectedCommunityId.trim() ||
    deps.getActiveCommunityId() !== deps.expectedCommunityId
  ) {
    throw new Error(
      "The community changed while continuing Website Manager setup. Switch back and try again.",
    );
  }

  const activeRelay = await deps.getRelayWsUrl();
  if (!isInstallCommunityActive(activeRelay, result)) {
    throw new Error(
      "This team was installed in a different community. Switch back to that community before adding it to a channel.",
    );
  }

  const ownerPubkey = assertScopeIdentity(
    await deps.getOwnerPubkey(),
    "owner identity",
  );
  if (ownerPubkey !== assertScopeIdentity(result.ownerPubkey, "owner")) {
    throw new Error(
      "The account changed while continuing Website Manager setup. Switch back to the installing account and try again.",
    );
  }
  if (deps.getActiveCommunityId() !== deps.expectedCommunityId) {
    throw new Error(
      "The community changed while continuing Website Manager setup. Switch back and try again.",
    );
  }
}

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
    joined: false,
    newlyAdded: false,
    ready: false,
    membershipAdded: false,
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
  await assertCurrentScope(result, deps);

  const agents = await deps.listManagedAgents();
  await assertCurrentScope(result, deps);
  const byPubkey = new Map(
    agents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
  );

  const outcomes: AgentStartOutcome[] = [];
  for (const persona of result.personas) {
    await assertCurrentScope(result, deps);
    const agent = byPubkey.get(normalizePubkey(persona.agentPubkey));
    if (!agent) {
      outcomes.push(
        outcomeFor(persona, {
          error: `${persona.displayName} was installed but is not in this community's agent list. Retry the installation.`,
        }),
      );
      continue;
    }
    let attached: AttachAgentResult;
    try {
      attached = await deps.attachAgent(channelId, agent);
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
      continue;
    }
    // A scope error after an attach is fatal to the whole continuation. Do
    // not catch it as one teammate's start failure and continue mutating the
    // newly active community.
    await assertCurrentScope(result, deps);
    outcomes.push(
      outcomeFor(persona, {
        joined: attached.joined,
        newlyAdded: attached.newlyAdded,
        ready: attached.ready,
        membershipAdded: attached.membershipAdded,
        started: attached.started,
        error: attached.error ?? null,
        needsConfiguration: attached.error
          ? looksLikeConfigurationError(attached.error)
          : false,
      }),
    );
  }
  return outcomes;
}
