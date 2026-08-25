import { useQuery } from "@tanstack/react-query";

import * as React from "react";

import {
  type EmployeeHead,
  type AgentRank,
  useEmployeeHeadsQuery,
} from "@/features/agents/employeeHeads";
import {
  fetchManagedAgentHeadEvents,
  managedAgentHeadsQueryKey,
  resolveManagedAgentRank,
  trustedManagedAgentHeads,
  type ManagedAgentHead,
} from "@/features/agents/managedAgentHeads";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import type { OrgMember } from "@/features/agents/orgTree";
import { escalationTarget } from "@/features/agents/orgTree";
import { useRetiredEmployeePubkeys } from "@/features/agents/retiredEmployees";
import { useArchivedIdentitiesSnapshotQuery } from "@/features/identity-archive/archivedSnapshot";
import type { ArchivedIdentitiesSnapshot } from "@/shared/api/tauriIdentityArchive";
import { truncatePubkey, normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Everyone on the org chart: hired employees first, then owner-authored
 * managed-agent heads whose rank resolves the same way the relay resolves
 * it (the employee filling the claimed role, else the head's own tier).
 *
 * An agent that appears in both sources keeps its employee row: the head is
 * relay-signed and richer than anything a 30177 head can say about it.
 *
 * A personal agent with NO resolvable rank is not dropped -- that was the
 * original bug which left every pre-existing personal agent off the chart
 * and unrankable. It lands in `unrankedAgents` so the People section can
 * offer a one-click path onto the chart. Only owner-authored heads are read
 * here (the scan happens in trustedManagedAgentHeads), so a self-published
 * head puts nothing in either list.
 *
 * Pubkeys the owner has retired or the relay has archived (NIP-IA
 * kind:13535) appear in neither list.
 */

/** A chart member that knows which side of the payroll it came from. */
export type OrgChartMember = OrgMember & {
  /**
   * True when rank and reporting line resolve through an owner-authored
   * kind-30177 head (a personal agent), not through an employee row. The
   * two kinds change rank through different events: employees via kind 9046,
   * personal agents via republishing their own head.
   */
  isPersonalAgent: boolean;
};

/** A personal agent the org chart cannot place yet: no rank resolves. */
export type UnrankedAgent = {
  /** Lowercase hex pubkey. */
  pubkey: string;
  name: string;
  role: string;
};

export function employeeHeadToOrgMember(head: EmployeeHead): OrgChartMember {
  return {
    pubkey: head.pubkey,
    name: head.name || truncatePubkey(head.pubkey),
    role: head.role,
    rank: head.rank,
    manager: head.manager,
    isPersonalAgent: false,
  };
}

function managedHeadToOrgMember(
  head: ManagedAgentHead,
  rank: NonNullable<ReturnType<typeof resolveManagedAgentRank>>,
): OrgChartMember {
  return {
    pubkey: head.pubkey,
    name: head.name || truncatePubkey(head.pubkey),
    role: head.roleId ?? "",
    rank,
    manager: head.manager,
    isPersonalAgent: true,
  };
}

/**
 * Pubkeys removed from BOTH output lists. Each source is a deny-list the
 * owner expressed elsewhere: `retired` is the device-local retirement
 * record, `archived` is the relay's kind-13535 archive snapshot and so
 * applies to every device.
 */
export type HiddenRosterPubkeys = {
  retired?: ReadonlySet<string>;
  archived?: ReadonlySet<string>;
};

/**
 * Absence of evidence hides nobody: callers pass empty or absent sets
 * while those reads load or fail, making "unknown" mean show-everything.
 * That direction is deliberate -- an empty set can only ever leave a leaked
 * agent visible for one more render, while the opposite would blank the
 * whole roster on a cold start or a relay error.
 */

/** Merged, normalized hidden set, or null when nothing is hidden. */
function hiddenPubkeySet(
  hidden: HiddenRosterPubkeys,
): ReadonlySet<string> | null {
  if (!hidden.retired?.size && !hidden.archived?.size) return null;
  const merged = new Set<string>();
  for (const pubkey of hidden.retired ?? []) {
    merged.add(normalizePubkey(pubkey));
  }
  for (const pubkey of hidden.archived ?? []) {
    merged.add(normalizePubkey(pubkey));
  }
  return merged;
}

/**
 * The roster's hidden set for an archive-snapshot query state. React Query
 * has no `data` while the snapshot loads, errored, or is disabled alike --
 * all three collapse to an empty set, i.e. hide nothing.
 */
export function archivedHiddenPubkeys(
  snapshot: ArchivedIdentitiesSnapshot | undefined,
): ReadonlySet<string> {
  if (!snapshot) return emptyPubkeys;
  const hidden = new Set<string>();
  for (const pubkey of snapshot.archived) {
    hidden.add(normalizePubkey(pubkey));
  }
  return hidden;
}

const emptyPubkeys: ReadonlySet<string> = new Set();

/**
 * Pure projection from the two head sources onto chart members and the
 * unranked group. Employees win collisions; a head at an employee's pubkey
 * adds nothing anywhere.
 */
export function orgMembersFromSources(
  heads: readonly EmployeeHead[],
  trustedHeads: readonly ManagedAgentHead[],
  hidden: HiddenRosterPubkeys = {},
): { members: OrgChartMember[]; unrankedAgents: UnrankedAgent[] } {
  const employeesByRole = new Map<string, { rank: OrgMember["rank"] }>();
  for (const head of heads) {
    if (head.role) employeesByRole.set(head.role, { rank: head.rank });
  }

  const members = new Map<string, OrgChartMember>();
  for (const head of heads) {
    members.set(head.pubkey, employeeHeadToOrgMember(head));
  }
  const unrankedAgents: UnrankedAgent[] = [];
  for (const trusted of trustedHeads) {
    if (members.has(trusted.pubkey)) continue;
    const rank = resolveManagedAgentRank(trusted, employeesByRole);
    if (!rank) {
      unrankedAgents.push({
        pubkey: trusted.pubkey,
        name: trusted.name || truncatePubkey(trusted.pubkey),
        role: trusted.roleId ?? "",
      });
      continue;
    }
    members.set(trusted.pubkey, managedHeadToOrgMember(trusted, rank));
  }

  const byPubkey = (a: { pubkey: string }, b: { pubkey: string }) =>
    normalizePubkey(a.pubkey).localeCompare(normalizePubkey(b.pubkey));
  const hiddenSet = hiddenPubkeySet(hidden);
  return {
    members: [...members.values()]
      .filter((member) => !hiddenSet?.has(normalizePubkey(member.pubkey)))
      .sort(byPubkey),
    unrankedAgents: unrankedAgents
      .filter((agent) => !hiddenSet?.has(normalizePubkey(agent.pubkey)))
      .sort(byPubkey),
  };
}

/**
 * Manager candidates for a member at `memberPubkey` moving to `selectedRank`:
 * agents exactly one rung up, never the member itself. A null or executive
 * selection has no escalation target and therefore no candidates. The picker
 * only narrows -- the relay still authorizes every edge.
 */
export function managerCandidatesFor(
  members: readonly OrgMember[],
  memberPubkey: string,
  selectedRank: AgentRank | null,
): OrgMember[] {
  const target = selectedRank ? escalationTarget(selectedRank) : null;
  if (!target) return [];
  return members.filter(
    (candidate) =>
      candidate.pubkey !== memberPubkey && candidate.rank === target,
  );
}

export function useOrgMembers(
  communityId: string,
  enabled = true,
): {
  members: OrgChartMember[];
  unrankedAgents: UnrankedAgent[];
  isLoading: boolean;
  error: Error | null;
} {
  const headsQuery = useEmployeeHeadsQuery(communityId, enabled);
  const ownersQuery = useCommunityOwnersQuery(communityId, enabled);
  const headEventsQuery = useQuery({
    queryKey: managedAgentHeadsQueryKey(communityId),
    queryFn: fetchManagedAgentHeadEvents,
    enabled: enabled && communityId !== "",
    staleTime: 30_000,
  });
  const retired = useRetiredEmployeePubkeys(communityId);
  const archivedSnapshotQuery = useArchivedIdentitiesSnapshotQuery(
    communityId,
    enabled,
  );

  return React.useMemo(() => {
    const heads = headsQuery.data;
    // Owners still loading is indistinguishable from "no owners": nothing
    // off a kind-30177 head may be trusted yet, so only employees render.
    const owners = ownersQuery.data ?? new Set<string>();
    if (!heads) {
      return {
        members: [],
        unrankedAgents: [],
        isLoading: headsQuery.isLoading,
        error: headsQuery.error instanceof Error ? headsQuery.error : null,
      };
    }

    // Retirement lives on the relay's row and no head carries it, so this
    // device keeps the employees it has retired out of the chart itself;
    // they surface in the retired tray instead of silently returning on the
    // next refetch. The relay's kind-13535 archive snapshot is the same
    // idea for every device: identities the relay has archived (e.g. the
    // boot-reconcile leak cleanup) leave both the chart and the unranked
    // group. While that snapshot loads or errors it is `undefined`, which
    // maps to an empty set -- an unknown archive hides nothing.
    const { members, unrankedAgents } = orgMembersFromSources(
      [...heads.values()],
      trustedManagedAgentHeads(headEventsQuery.data ?? [], owners),
      {
        retired,
        archived: archivedHiddenPubkeys(archivedSnapshotQuery.data),
      },
    );

    return {
      members,
      unrankedAgents,
      isLoading: headsQuery.isLoading || ownersQuery.isLoading,
      error:
        headsQuery.error instanceof Error
          ? headsQuery.error
          : headEventsQuery.error instanceof Error
            ? headEventsQuery.error
            : null,
    };
  }, [
    headsQuery.data,
    headsQuery.error,
    headsQuery.isLoading,
    ownersQuery.data,
    ownersQuery.isLoading,
    headEventsQuery.data,
    headEventsQuery.error,
    retired,
    archivedSnapshotQuery.data,
  ]);
}
