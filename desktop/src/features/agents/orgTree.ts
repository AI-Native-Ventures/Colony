import type { AgentRank } from "@/features/agents/employeeHeads";

/**
 * The org tree: a pure projection of reporting lines onto a renderable
 * forest. No React, no IO, no relay -- input in, roots plus an unassigned
 * list out.
 *
 * Rules (spec 3.6):
 * - Agents only; humans are never part of this data.
 * - Executives are the roots. Several executives means several roots.
 * - Every edge must climb exactly one rung (worker -> leader,
 *   leader -> executive), mirroring what the relay enforces at ingest. An
 *   edge that does not -- manager unknown, deleted, wrong rank, or an
 *   executive carrying a manager -- resolves to NO edge.
 * - Nothing is dropped. An agent whose line does not resolve lands in
 *   `unassigned` so it stays visible; when its manager exists but is itself
 *   unplaced, the whole unplaced subtree keeps its shape inside the tray.
 * - Termination is guaranteed on ANY input by construction and again by a
 *   visited guard during descent: a hostile or corrupt head may not hang
 *   the UI even though the ladder's geometry makes cycles unrepresentable.
 */

/** One agent on the chart, already resolved to its rank and manager. */
export type OrgMember = {
  /** Lowercase hex pubkey. */
  pubkey: string;
  name: string;
  role: string;
  rank: AgentRank;
  /** The manager this member reports to (pubkey), or null. */
  manager: string | null;
};

/** A member placed in the tree or tray, with its nested reports. */
export type OrgTreeNode = {
  member: OrgMember;
  reports: OrgTreeNode[];
};

export type OrgTree = {
  roots: OrgTreeNode[];
  /**
   * Topmost members no root claims: agents with no resolvable manager,
   * each carrying whatever reports still resolve to them.
   */
  unassigned: OrgTreeNode[];
};

/**
 * The rung directly above each rank, mirroring `AgentTier::escalation_target`
 * in `crates/buzz-core/src/interrupt.rs`. An executive has no target: it is
 * the top of the ladder and reports to no agent.
 */
const ESCALATION_TARGET: Record<AgentRank, AgentRank | null> = {
  worker: "leader",
  leader: "executive",
  executive: null,
};

/**
 * The rank a manager of `rank` must sit at for the edge to be one the relay
 * would accept. The manager picker narrows to exactly this rank; the relay
 * still authorizes -- the picker is a guardrail, never the guard.
 */
export function escalationTarget(rank: AgentRank): AgentRank | null {
  return ESCALATION_TARGET[rank];
}

function compareMembers(a: OrgMember, b: OrgMember): number {
  return a.name.localeCompare(b.name) || a.pubkey.localeCompare(b.pubkey);
}

function sortTreeNodes(nodes: OrgTreeNode[]): OrgTreeNode[] {
  return nodes.sort((a, b) => compareMembers(a.member, b.member));
}

/**
 * Build the org tree. Every input member appears exactly once across the
 * roots' descendants and the unassigned tray.
 */
export function buildOrgTree(members: readonly OrgMember[]): OrgTree {
  // Dedupe by pubkey, first occurrence wins: builders upstream never emit
  // duplicates, but hostile input must not produce a node twice.
  const byPubkey = new Map<string, OrgMember>();
  for (const member of members) {
    if (!byPubkey.has(member.pubkey)) {
      byPubkey.set(member.pubkey, member);
    }
  }

  // Valid edges only. A self-manager fails the rung check without any
  // explicit comparison: no rank escalates to itself.
  const validManagerOf = new Map<string, string>();
  for (const member of byPubkey.values()) {
    const target = ESCALATION_TARGET[member.rank];
    if (!target || !member.manager) continue;
    const manager = byPubkey.get(member.manager);
    if (manager && manager.rank === target) {
      validManagerOf.set(member.pubkey, manager.pubkey);
    }
  }

  const reportsOf = new Map<string, OrgMember[]>();
  for (const member of byPubkey.values()) {
    const managerPubkey = validManagerOf.get(member.pubkey);
    if (!managerPubkey) continue;
    const reports = reportsOf.get(managerPubkey);
    if (reports) {
      reports.push(member);
    } else {
      reportsOf.set(managerPubkey, [member]);
    }
  }

  // Descend iteratively with a visited set. Edges validated above cannot
  // cycle, but the guard costs one Set and removes the trust entirely.
  const visited = new Set<string>();
  const descend = (member: OrgMember): OrgTreeNode => {
    visited.add(member.pubkey);
    const reports = sortTreeNodes(
      (reportsOf.get(member.pubkey) ?? [])
        .filter((report) => !visited.has(report.pubkey))
        .map(descend),
    );
    return { member, reports };
  };

  const roots = sortTreeNodes(
    [...byPubkey.values()]
      .filter((member) => member.rank === "executive")
      .map(descend),
  );

  // Topmost unplaced: no valid edge of their own. A member with a valid edge
  // to another unplaced member renders beneath that member inside the tray,
  // so its reporting line stays readable and it is never listed twice.
  const unassigned = sortTreeNodes(
    [...byPubkey.values()]
      .filter(
        (member) =>
          !visited.has(member.pubkey) && !validManagerOf.has(member.pubkey),
      )
      .map(descend),
  );

  return { roots, unassigned };
}
