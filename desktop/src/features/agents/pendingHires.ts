import * as React from "react";

import type { AgentRank } from "@/features/agents/employeeHeads";

/**
 * Hire requests this device filed whose employee head has not landed yet.
 *
 * The relay mints the hired agent's keypair and republishes the head
 * asynchronously, so between the accepted 9045 and the arriving 30190 the
 * new hire exists only as this pending state. The UI must say so: a bare
 * spinner with no explanation reads as a hang, not a mint in progress.
 *
 * Module-level because the pending request outlives the dialog that filed
 * it. Community-scoped and cleared by `resetPendingHireState()` on community
 * switches -- a pending hire for one workspace must never surface in
 * another's roster.
 */

export type PendingHire = {
  id: string;
  role: string;
  name: string;
  rank: AgentRank;
  requestedAt: number;
};

const pendingByCommunity = new Map<string, PendingHire[]>();

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function snapshotFor(communityId: string): PendingHire[] {
  return pendingByCommunity.get(communityId) ?? [];
}

// Stable empty snapshot so useSyncExternalStore does not loop on identity.
const EMPTY: PendingHire[] = [];

export function subscribePendingHires(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPendingHires(communityId: string): PendingHire[] {
  const pending = pendingByCommunity.get(communityId);
  return pending && pending.length > 0 ? pending : EMPTY;
}

export function recordPendingHire(
  communityId: string,
  hire: Omit<PendingHire, "id" | "requestedAt">,
): void {
  const pending = snapshotFor(communityId);
  // Role slugs are unique per relay: a second hire for the same role means
  // the first is either landed or was refused; replace instead of stacking.
  const next = [
    ...pending.filter((entry) => entry.role !== hire.role),
    {
      ...hire,
      id: `${Date.now()}-${hire.role}`,
      requestedAt: Date.now(),
    },
  ];
  pendingByCommunity.set(communityId, next);
  notify();
}

/** Drop every pending hire whose role now has an employee head. */
export function dismissLandedPendingHires(
  communityId: string,
  filledRoles: ReadonlySet<string>,
): void {
  const pending = pendingByCommunity.get(communityId);
  if (!pending) return;
  const remaining = pending.filter((entry) => !filledRoles.has(entry.role));
  if (remaining.length === pending.length) return;
  if (remaining.length === 0) {
    pendingByCommunity.delete(communityId);
  } else {
    pendingByCommunity.set(communityId, remaining);
  }
  notify();
}

/** Community-switch reset (see resetCommunityState in useCommunityInit). */
export function resetPendingHireState(): void {
  if (pendingByCommunity.size === 0) return;
  pendingByCommunity.clear();
  notify();
}

export function usePendingHires(communityId: string): PendingHire[] {
  return React.useSyncExternalStore(
    subscribePendingHires,
    () => getPendingHires(communityId),
    () => EMPTY,
  );
}
