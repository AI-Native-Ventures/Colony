/**
 * Where a newly created agent lands on the org chart when the owner did not
 * place it by hand.
 *
 * Placement was optional and defaulted to nothing, so every agent created
 * without touching the placement fields published no rank and no manager. The
 * People screen showed the whole roster under UNASSIGNED, and because nothing
 * reports to anyone, no agent belongs to a team the company contract will
 * accept: assigning work to one fails with "task assignees must belong to a
 * supplied team", and escalations have nowhere to climb.
 *
 * An unplaced agent is never the state an owner chose. It is what a create
 * looks like when nobody filled the form in.
 */
import type { AgentRank } from "@/features/agents/employeeHeads";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** The role that runs the company on the owner's behalf. */
export const CHIEF_OF_STAFF_ROLE_ID = "chief-of-staff";

export type OrgPlacement = {
  tier: AgentRank;
  /** Manager pubkey, or null when this agent reports to nobody. */
  manager: string | null;
};

/**
 * The pubkey of the agent currently holding Chief of Staff, or null.
 *
 * Matched on the persona's `roleId`, never on a display name: names are
 * branding and get renamed, the role id is the stable identity the relay and
 * the mention system both key off.
 */
export function chiefOfStaffPubkey(
  agents: readonly ManagedAgent[] | undefined,
  personas: readonly AgentPersona[] | undefined,
): string | null {
  const chiefPersonaIds = new Set(
    (personas ?? [])
      .filter((persona) => persona.roleId === CHIEF_OF_STAFF_ROLE_ID)
      .map((persona) => persona.id),
  );
  if (chiefPersonaIds.size === 0) return null;
  for (const agent of agents ?? []) {
    if (agent.personaId && chiefPersonaIds.has(agent.personaId)) {
      return normalizePubkey(agent.pubkey);
    }
  }
  return null;
}

/**
 * Rank and manager for a freshly created agent.
 *
 * Mirrors `rankImpliedByRole` on the read side so a head written here and a
 * head read there agree: Chief of Staff is an executive by definition, every
 * other role is a team lead. A worker "may never address owners"
 * (`buzz_core::interrupt`), so defaulting to worker would create agents whose
 * escalations have nowhere to go at all.
 *
 * The Chief of Staff reports to the owner, not to itself, so it is the one
 * agent that gets no manager.
 */
export function resolveDefaultOrgPlacement(input: {
  /** Role of the persona the new agent was created from. */
  roleId: string | null;
  agents: readonly ManagedAgent[] | undefined;
  personas: readonly AgentPersona[] | undefined;
}): OrgPlacement {
  if (input.roleId === CHIEF_OF_STAFF_ROLE_ID) {
    return { tier: "executive", manager: null };
  }
  return {
    tier: "leader",
    manager: chiefOfStaffPubkey(input.agents, input.personas),
  };
}

/**
 * The placement to publish: what the owner chose, else the default.
 *
 * An owner-chosen rank with no manager stays without one. Choosing a rank is
 * a deliberate act, and quietly attaching a manager to it would overrule a
 * decision that was actually made.
 */
export function orgPlacementForCreate(
  chosen: { rank?: AgentRank; manager?: string } | undefined,
  fallback: OrgPlacement,
): OrgPlacement {
  if (chosen?.rank) {
    return { tier: chosen.rank, manager: chosen.manager ?? null };
  }
  return fallback;
}
