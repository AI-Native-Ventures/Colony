import type { LeadDetail } from "../types";

type LeadUpdateListener = (lead: LeadDetail) => void;

/**
 * Cross-component notification that one lead's editable profile changed.
 *
 * The Leads list keeps its rows in local state and remounts when the route
 * read model refreshes, so the drawer publishes its receipt here and the
 * list merges the module-level value into its rows in place. Subscribers
 * unsubscribe on unmount; the reset is the community remount boundary (see
 * AGENTS.md "Community Switching").
 *
 * Known cost, on the read side. A receipt is the authority on what persisted
 * at the moment it was written, but it then outlives every later refetch
 * until the community remount clears it. So if another member edits the same
 * lead afterwards, the list keeps showing the older local receipt on top of
 * the relay's newer row, while the drawer, which refetches on open, shows
 * the fresh one. That is the read-side face of the last-write-wins tradeoff
 * the write path already accepts.
 *
 * It is not fixable here: `LeadProjection` carries `added_at` and `status`
 * but no `updated_at`, so a row and a receipt cannot be compared for
 * freshness. Clearing on page arrival would be worse, because the route
 * hands back `initialLeads` that may predate the edit, which is exactly what
 * this cache exists to survive. Closing it needs `updated_at` on the list
 * projection.
 */
const listeners = new Set<LeadUpdateListener>();
const recentLeadUpdates = new Map<string, LeadDetail>();

export function subscribeLeadUpdates(listener: LeadUpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLeadUpdate(lead: LeadDetail): void {
  recentLeadUpdates.set(lead.id, lead);
  for (const listener of [...listeners]) listener(lead);
}

/** The last successful update receipt for a lead, if any. */
export function recentLeadDetail(leadId: string): LeadDetail | undefined {
  return recentLeadUpdates.get(leadId);
}

/** Drop community-bound listeners and receipts on relay boundary changes. */
export function resetLeadUpdateListeners(): void {
  listeners.clear();
  recentLeadUpdates.clear();
}
