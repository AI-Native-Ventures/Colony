import type { DelegationGrant } from "@/features/agents/delegationGrants";
import type { AgentRank } from "@/features/agents/employeeHeads";

/**
 * What delegation authority means at each rank, as sentences the org chart
 * can say.
 *
 * The model these functions must never lie about: a grant carries NO holder.
 * `ParsedGrant` (buzz-core interrupt.rs) is grant_id, category, scope, cap,
 * active; `enforce_decision_log_authority` (interrupt_gate.rs) authorizes a
 * decision from exactly two facts: the signer's rank (leader or executive)
 * and an active, category-matching, cap-satisfying grant. A grant is a
 * community-wide capability every leader-rank-or-above agent holds at once.
 *
 * So the per-node signal below speaks of RANK capability only ("can this
 * rank act under a delegation at all"), and the community line names no
 * holder. Nothing here may render a grant as belonging to one agent.
 */

/**
 * The ranks `enforce_decision_log_authority` accepts a decision log from.
 * A worker cannot spend delegated authority no matter how many grants are
 * active; that is the difference between "junior" and "cannot decide".
 */
const DELEGATION_CAPABLE_RANKS: ReadonlySet<AgentRank> = new Set([
  "leader",
  "executive",
]);

export function rankCanUseDelegations(rank: AgentRank): boolean {
  return DELEGATION_CAPABLE_RANKS.has(rank);
}

/** Per-node label. Rank-only by design: it says nothing about which grants exist. */
export function rankDelegationLabel(rank: AgentRank): string {
  return rankCanUseDelegations(rank)
    ? "Can use delegations"
    : "Cannot use delegations";
}

function activeGrantCount(grants: readonly DelegationGrant[]): number {
  return grants.filter((grant) => grant.active).length;
}

/**
 * The one community-level line, above the tree. Counts only grants whose
 * current head is active: a revoked head revokes without deleting, so the
 * raw event count would overstate the authority that actually exists.
 */
export function describeActiveDelegations(
  grants: readonly DelegationGrant[],
): string {
  const count = activeGrantCount(grants);
  const noun = count === 1 ? "delegation" : "delegations";
  return `${count} active ${noun}, available to every Team lead and Chief of staff.`;
}

export const DELEGATION_AUTHORITY_WARNING_TITLE =
  "Leadership without delegated authority";

export const DELEGATION_AUTHORITY_WARNING_BODY =
  "Team leads or chiefs of staff sit on this chart, but no delegation is currently active. Escalated work has somewhere to go and no authority when it gets there.";

/**
 * The org-level hole: escalation has somewhere to go and nothing behind it
 * when it arrives. True when at least one leader-or-above rank sits on the
 * chart while zero active grants exist. Workers alone do not qualify: with
 * nobody able to use authority, its absence is not a live gap.
 */
export function delegationAuthorityGap({
  members,
  grants,
}: {
  members: ReadonlyArray<{ rank: AgentRank | null }>;
  grants: readonly DelegationGrant[];
}): boolean {
  const hasLeadership = members.some(
    (member) => member.rank !== null && rankCanUseDelegations(member.rank),
  );
  return hasLeadership && activeGrantCount(grants) === 0;
}
