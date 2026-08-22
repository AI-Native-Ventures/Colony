import { useQuery } from "@tanstack/react-query";

import * as React from "react";

import {
  type EmployeeHead,
  useEmployeeHeadsQuery,
} from "@/features/agents/employeeHeads";
import {
  fetchManagedAgentHeadEvents,
  managedAgentHeadsQueryKey,
  resolveManagedAgentRank,
  trustedManagedAgentHeads,
} from "@/features/agents/managedAgentHeads";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import type { OrgMember } from "@/features/agents/orgTree";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Everyone on the org chart: hired employees first, then owner-authored
 * managed-agent heads whose rank resolves the same way the relay resolves
 * it (the employee filling the claimed role, else the head's own tier).
 *
 * An agent that appears in both sources keeps its employee row: the head is
 * relay-signed and richer than anything a 30177 head can say about it.
 */
export function employeeHeadToOrgMember(head: EmployeeHead): OrgMember {
  return {
    pubkey: head.pubkey,
    name: head.name || truncatePubkey(head.pubkey),
    role: head.role,
    rank: head.rank,
    manager: head.manager,
  };
}

export function useOrgMembers(communityId: string): {
  members: OrgMember[];
  isLoading: boolean;
  error: Error | null;
} {
  const headsQuery = useEmployeeHeadsQuery(communityId);
  const ownersQuery = useCommunityOwnersQuery(communityId);
  const headEventsQuery = useQuery({
    queryKey: managedAgentHeadsQueryKey(communityId),
    queryFn: fetchManagedAgentHeadEvents,
    enabled: communityId !== "",
    staleTime: 30_000,
  });

  return React.useMemo(() => {
    const heads = headsQuery.data;
    // Owners still loading is indistinguishable from "no owners": nothing
    // off a kind-30177 head may be trusted yet, so only employees render.
    const owners = ownersQuery.data ?? new Set<string>();
    if (!heads) {
      return {
        members: [],
        isLoading: headsQuery.isLoading,
        error: headsQuery.error instanceof Error ? headsQuery.error : null,
      };
    }

    const employeesByRole = new Map<string, { rank: OrgMember["rank"] }>();
    for (const head of heads.values()) {
      if (head.role) employeesByRole.set(head.role, { rank: head.rank });
    }

    const members = new Map<string, OrgMember>();
    for (const head of heads.values()) {
      members.set(head.pubkey, employeeHeadToOrgMember(head));
    }
    for (const trusted of trustedManagedAgentHeads(
      headEventsQuery.data ?? [],
      owners,
    )) {
      if (members.has(trusted.pubkey)) continue;
      const rank = resolveManagedAgentRank(trusted, employeesByRole);
      if (!rank) continue;
      members.set(trusted.pubkey, {
        pubkey: trusted.pubkey,
        name: trusted.name || truncatePubkey(trusted.pubkey),
        role: trusted.roleId ?? "",
        rank,
        manager: trusted.manager,
      });
    }

    return {
      members: [...members.values()].sort((a, b) =>
        normalizePubkey(a.pubkey).localeCompare(normalizePubkey(b.pubkey)),
      ),
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
  ]);
}
