import type { LeadDetail } from "../types";

type LeadUpdateListener = (lead: LeadDetail) => void;

/**
 * Cross-component notification that one lead's editable profile changed.
 *
 * The Leads list keeps its rows in local state and remounts when the route
 * read model refreshes, so the drawer publishes its receipt here and the
 * list merges the module-level value into its rows in place. The receipt is
 * the authority on what persisted, so the cache holds the last successful
 * result per lead. Subscribers unsubscribe on unmount; the reset is the
 * community remount boundary (see AGENTS.md "Community Switching").
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
