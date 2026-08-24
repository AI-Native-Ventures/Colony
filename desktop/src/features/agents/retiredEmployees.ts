import * as React from "react";

/**
 * Employees this device retired, kept so they stay off the org chart.
 *
 * Retirement is a status on the relay's employees row. No event carries it:
 * kind 9046 does not republish a head on retirement, and the last head the
 * employee has still parses to a full chart member. Until a head-level
 * signal exists, the only way a retirement shows in the UI is the device
 * that filed it remembering -- so the retired employee leaves the chart but
 * stays discoverable in the People section's retired tray, with the record
 * untouched on the relay.
 *
 * Module-level because retirements outlive the dialog that filed them.
 * Community-scoped and cleared by `resetRetiredEmployeeState()` on community
 * switches: a retirement filed in one workspace must never hide anyone in
 * another.
 */

export type RetiredEmployee = {
  /** Lowercase hex pubkey of the retired employee. */
  pubkey: string;
  name: string;
  retiredAt: number;
};

const retiredByCommunity = new Map<string, RetiredEmployee[]>();

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

// Stable empty snapshot so useSyncExternalStore does not loop on identity.
const EMPTY: RetiredEmployee[] = [];

const emptyPubkeys: ReadonlySet<string> = new Set();

export function subscribeRetiredEmployees(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRetiredEmployees(communityId: string): RetiredEmployee[] {
  const retired = retiredByCommunity.get(communityId);
  return retired && retired.length > 0 ? retired : EMPTY;
}

/** Record a successful retirement so the employee leaves the chart. */
export function recordRetiredEmployee(
  communityId: string,
  employee: { pubkey: string; name: string },
): void {
  const retired = getRetiredEmployees(communityId);
  if (retired.some((entry) => entry.pubkey === employee.pubkey)) return;
  retiredByCommunity.set(communityId, [
    ...retired,
    { ...employee, retiredAt: Date.now() },
  ]);
  notify();
}

/** Community-switch reset (see resetCommunityState in useCommunityInit). */
export function resetRetiredEmployeeState(): void {
  if (retiredByCommunity.size === 0) return;
  retiredByCommunity.clear();
  notify();
}

/** The retired pubkeys for `communityId`, or a stable empty set. */
export function useRetiredEmployeePubkeys(
  communityId: string,
): ReadonlySet<string> {
  const retired = React.useSyncExternalStore(
    subscribeRetiredEmployees,
    () => getRetiredEmployees(communityId),
    () => EMPTY,
  );
  return React.useMemo(() => {
    if (retired.length === 0) return emptyPubkeys;
    return new Set(retired.map((entry) => entry.pubkey));
  }, [retired]);
}

/** The retired rows themselves, for the tray that keeps them discoverable. */
export function useRetiredEmployees(communityId: string): RetiredEmployee[] {
  return React.useSyncExternalStore(
    subscribeRetiredEmployees,
    () => getRetiredEmployees(communityId),
    () => EMPTY,
  );
}
