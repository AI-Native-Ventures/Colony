import * as React from "react";

import { useQuery } from "@tanstack/react-query";

import type { EmployeeHead } from "@/features/agents/employeeHeads";
import { useEmployeeHeadsQuery } from "@/features/agents/employeeHeads";
import {
  fetchManagedAgentHeadEvents,
  managedAgentHeadsQueryKey,
  trustedManagedAgentHeads,
  type ManagedAgentHead,
} from "@/features/agents/managedAgentHeads";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";

/**
 * Reading an agent's reporting line the way the relay's `agent_manager`
 * reads it (`crates/buzz-relay/src/interrupt_gate.rs`):
 *
 * 1. an employee head for this pubkey -> its `manager` tag (the relay-minted
 *    payroll record; authoritative even when it names nobody);
 * 2. else a TRUSTED managed-agent head -> its `manager` tag, where trusted
 *    means authored by a current community owner. Kind 30177 is
 *    client-writable, so `trustedManagedAgentHeads` performs the same
 *    newest-first owner-author scan the relay does before reading anything
 *    off a head -- a self-published head names nothing.
 *
 * Display-only divergence: the relay additionally validates that the edge
 * climbs exactly one rung before ENFORCING it. The org surfaces render the
 * authoritative record itself, matching `orgMembers.ts`.
 */

/** One agent's reporting line, or the explicit absence of one. */
export type ReportingLine = {
  /** The manager pubkey (normalized hex), or null when the agent reports to nobody. */
  managerPubkey: string | null;
  /**
   * How to say the manager's name: employee-head name, then managed-agent
   * head name, then the canonical truncated pubkey. Null when there is no
   * manager, so a surface never renders a blank.
   */
  managerLabel: string | null;
};

/**
 * Resolve one agent's reporting line from the two sources the relay reads.
 * Pure so surfaces can test it without React Query running.
 */
export function resolveReportingLine(
  pubkey: string,
  sources: {
    employees?: ReadonlyMap<string, Pick<EmployeeHead, "manager" | "name">>;
    trustedHeads?: readonly Pick<
      ManagedAgentHead,
      "pubkey" | "manager" | "name"
    >[];
  },
): ReportingLine {
  const normalized = normalizePubkey(pubkey);
  const employees = sources.employees;
  const trustedHeads = sources.trustedHeads ?? [];

  // Source 1: the employee head is authoritative when it exists -- even when
  // its own manager tag is absent, exactly as the relay stops at step 1.
  const employeeHead = employees?.get(normalized);
  const claimedManager =
    employeeHead !== undefined
      ? employeeHead.manager
      : (trustedHeads.find(
          (head) => normalizePubkey(head.pubkey) === normalized,
        )?.manager ?? null);

  if (!claimedManager) {
    return { managerPubkey: null, managerLabel: null };
  }

  const managerNormalized = normalizePubkey(claimedManager);
  const managerLabel =
    employees?.get(managerNormalized)?.name ||
    trustedHeads.find(
      (head) => normalizePubkey(head.pubkey) === managerNormalized,
    )?.name ||
    truncatePubkey(managerNormalized);

  return { managerPubkey: managerNormalized, managerLabel };
}

type ReportingLineSources = {
  employees: ReadonlyMap<string, EmployeeHead> | null;
  trustedHeads: ManagedAgentHead[];
};

function useReportingLineSources(
  communityId: string,
  enabled: boolean,
): ReportingLineSources {
  const headsQuery = useEmployeeHeadsQuery(communityId, enabled);
  const ownersQuery = useCommunityOwnersQuery(communityId, enabled);
  const headEventsQuery = useQuery({
    queryKey: managedAgentHeadsQueryKey(communityId),
    queryFn: fetchManagedAgentHeadEvents,
    enabled: enabled && communityId !== "",
    staleTime: 30_000,
  });

  const owners = ownersQuery.data;
  const headEvents = headEventsQuery.data ?? [];
  // A missing owner set resolves to "nothing trusted yet" inside the memo,
  // so an in-flight owners read cannot churn the trusted-head list.
  const trustedHeads = React.useMemo(
    () => trustedManagedAgentHeads(headEvents, owners ?? new Set<string>()),
    [headEvents, owners],
  );

  return {
    employees: headsQuery.data ?? null,
    // Owners still loading is indistinguishable from "no owners": nothing
    // off a kind-30177 head may be trusted yet, so only employee-head lines
    // resolve -- fail closed, as `orgMembers.ts` does.
    trustedHeads,
  };
}

/**
 * A stable lookup of one agent's reporting line by pubkey, for callers that
 * classify many agents against one set of sources (ask routing).
 */
export function useReportingLineLookup(communityId: string): {
  lookup: (pubkey: string | null | undefined) => ReportingLine;
} {
  const sources = useReportingLineSources(communityId, communityId !== "");
  const employees = sources.employees;
  const trustedHeads = sources.trustedHeads;
  const lookup = React.useCallback(
    (pubkey: string | null | undefined) =>
      pubkey
        ? resolveReportingLine(pubkey, {
            employees: employees ?? undefined,
            trustedHeads,
          })
        : { managerPubkey: null, managerLabel: null },
    [employees, trustedHeads],
  );
  return { lookup };
}

/**
 * One agent's reporting line. While the underlying queries settle, the line
 * resolves from whatever is already cached; consumers rendering alongside a
 * rank badge gate on `rank` presence, which needs the same heads query.
 */
export function useAgentReportingLine(
  communityId: string,
  pubkey: string | null | undefined,
): ReportingLine {
  const { lookup } = useReportingLineLookup(communityId);
  return React.useMemo(() => lookup(pubkey), [lookup, pubkey]);
}
