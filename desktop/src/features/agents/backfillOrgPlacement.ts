/**
 * Placing agents that are already unassigned.
 *
 * `resolveDefaultOrgPlacement` covers agents created from now on. It cannot
 * help the ones whose heads were already republished without a `manager` tag:
 * they sit under UNASSIGNED, belong to no team the company contract accepts,
 * and work cannot be assigned to them at all.
 *
 * This decides who gets placed and under whom. It publishes nothing; the
 * caller owns the relay writes, so the decision stays testable without a
 * relay, keys, or React.
 */
import type { AgentRank } from "@/features/agents/employeeHeads";
import {
  CHIEF_OF_STAFF_ROLE_ID,
  chiefOfStaffPubkey,
} from "@/features/agents/defaultOrgPlacement";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** One agent the backfill would place, and where. */
export type BackfillPlacement = {
  pubkey: string;
  name: string;
  tier: AgentRank;
  manager: string | null;
};

export type BackfillPlan = {
  /** Placements to publish, in the order they should be attempted. */
  placements: BackfillPlacement[];
  /** Pubkey of the agent everything else reports to, or null. */
  chiefOfStaff: string | null;
  /**
   * Why the plan is empty, when it is. Lets the caller say something true
   * rather than showing a button that silently does nothing.
   */
  blockedReason: "no-chief-of-staff" | "nothing-to-place" | null;
};

type UnplacedAgent = {
  pubkey: string;
  name: string;
  /** Rank already resolved for this agent, when it has one. */
  rank?: AgentRank | null;
};

/**
 * Plan the backfill.
 *
 * Rules, each of which exists because the alternative is wrong rather than
 * merely different:
 *
 * - No Chief of Staff deployed means no plan at all. Placing everyone under
 *   nobody is what the roster already looks like.
 * - The Chief of Staff is never given a manager. It reports to the owner, and
 *   pointing it at itself would be a cycle the org chart cannot draw.
 * - An agent that already has a rank keeps it. This restores reporting lines;
 *   it is not a re-rank, and silently promoting a worker to team lead would
 *   hand it the ability to address the owner.
 * - An agent with no rank at all takes `leader`, matching
 *   `rankImpliedByRole`, because a worker that reports to nobody has nowhere
 *   to escalate.
 */
export function planOrgBackfill(input: {
  unplaced: readonly UnplacedAgent[];
  agents: readonly ManagedAgent[] | undefined;
  personas: readonly AgentPersona[] | undefined;
}): BackfillPlan {
  const chief = chiefOfStaffPubkey(input.agents, input.personas);
  if (!chief) {
    return {
      placements: [],
      chiefOfStaff: null,
      blockedReason: "no-chief-of-staff",
    };
  }

  const chiefPersonaIds = new Set(
    (input.personas ?? [])
      .filter((persona) => persona.roleId === CHIEF_OF_STAFF_ROLE_ID)
      .map((persona) => persona.id),
  );
  const isChief = (pubkey: string) => {
    const normalized = normalizePubkey(pubkey);
    if (normalized === chief) return true;
    // A second agent on the chief-of-staff persona is still a Chief of Staff,
    // and must not be filed under the first one.
    return (input.agents ?? []).some(
      (agent) =>
        normalizePubkey(agent.pubkey) === normalized &&
        agent.personaId !== null &&
        agent.personaId !== undefined &&
        chiefPersonaIds.has(agent.personaId),
    );
  };

  const placements = input.unplaced
    .filter((agent) => !isChief(agent.pubkey))
    .map((agent) => ({
      pubkey: normalizePubkey(agent.pubkey),
      name: agent.name,
      tier: agent.rank ?? ("leader" as AgentRank),
      manager: chief,
    }));

  return {
    placements,
    chiefOfStaff: chief,
    blockedReason: placements.length === 0 ? "nothing-to-place" : null,
  };
}

/** What the button should say for a plan, or null when it must not appear. */
export function backfillLabel(plan: BackfillPlan): string | null {
  if (plan.blockedReason === "no-chief-of-staff") return null;
  if (plan.placements.length === 0) return null;
  const count = plan.placements.length;
  return count === 1
    ? "Place 1 agent under the Chief of Staff"
    : `Place ${count} agents under the Chief of Staff`;
}
