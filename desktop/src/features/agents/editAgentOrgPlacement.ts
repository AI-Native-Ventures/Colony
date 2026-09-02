import type { AgentRank } from "@/features/agents/employeeHeads";
import type { OrgChartMember } from "@/features/agents/orgMembers";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Seeding the Edit agent dialog's org placement.
 *
 * `ManagedAgent` carries no rank or reporting line (see
 * `desktop/src/shared/api/types.ts`), so the dialog cannot read the current
 * placement off the agent it is editing. The org chart is the only read
 * model that resolves both, which is why the seed comes from the chart's
 * members rather than from the record the rest of the dialog edits.
 */

/** The placement a dialog opens on, and what it may publish it through. */
export type SeededOrgPlacement = {
  rank: AgentRank;
  /** "" means no manager. */
  manager: string;
  /** False when the org chart has no row for this agent yet. */
  known: boolean;
  /**
   * True when a change must be published as an owner-authored kind-30177
   * head rather than a kind-9046 employee update. An agent the chart does
   * not know has no employee row to update, so it is treated as personal.
   */
  isPersonalAgent: boolean;
};

/** The two fields a placement edit can move. */
export type OrgPlacementValues = {
  rank: AgentRank | "";
  manager: string;
};

/**
 * The placement to open on for `pubkey`. An agent the chart cannot place
 * yet seeds as an unmanaged team lead: the dialog disables the block in that
 * case, so the value is a resting default, never something it publishes.
 */
export function seedOrgPlacement(
  members: readonly OrgChartMember[],
  pubkey: string,
): SeededOrgPlacement {
  const wanted = normalizePubkey(pubkey);
  const member = members.find(
    (candidate) => normalizePubkey(candidate.pubkey) === wanted,
  );
  if (!member) {
    return {
      rank: "leader",
      manager: "",
      known: false,
      isPersonalAgent: true,
    };
  }
  return {
    rank: member.rank ?? "leader",
    manager: member.manager ?? "",
    known: true,
    isPersonalAgent: member.isPersonalAgent,
  };
}

/** Whether a draft placement moves either field off the seeded one. */
export function orgPlacementChanged(
  seeded: OrgPlacementValues,
  draft: OrgPlacementValues,
): boolean {
  return seeded.rank !== draft.rank || seeded.manager !== draft.manager;
}
