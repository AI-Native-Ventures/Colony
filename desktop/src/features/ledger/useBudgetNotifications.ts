import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import type { NotificationSettings } from "@/features/notifications/hooks";
import {
  requestDockBounce,
  sendDesktopNotification,
} from "@/features/notifications/lib/desktop";
import {
  playNotificationSound,
  resolveSlotSound,
} from "@/features/notifications/lib/sound";

import { useLedgerReport } from "./hooks";
import {
  type BudgetSignal,
  budgetExceededSignals,
  mergeBudgetNotificationKeys,
} from "./lib/budgetSignals";

/**
 * Telling the owner when a budget has been passed.
 *
 * A budget was a number on a screen. Nothing read it out, so the only way to
 * find out a cost centre had blown through its limit was to open the Spend
 * screen and look, which nobody does on the day it happens.
 *
 * This follows `useAskNotifications` rather than inventing a second
 * mechanism: the same `sendDesktopNotification`, the same `needs_action`
 * sound slot, the same `desktopEnabled` master switch and per-slot row in
 * Settings, the same dock bounce, the same localStorage dedupe set scoped to
 * community and identity.
 *
 * It differs in one deliberate place. Asks seed their dedupe set on the first
 * resolved pass, so launching the app never announces a backlog. Budgets do
 * not seed. A budget crossing is a standing state rather than an event that
 * arrived: if a cost centre went over while the app was closed, that is still
 * true when it opens, and it is exactly what the owner needs to hear. The
 * dedupe set then holds, so it is said once per cost centre per month per
 * machine and not again.
 *
 * Mount once, at app level.
 */

/**
 * How often the watcher recomputes the ledger.
 *
 * Half an hour, not a minute. Recomputing decrypts every usage record, and
 * a monthly budget does not move fast enough to justify paying that on a
 * short timer. Being told half an hour late that a monthly limit was passed
 * costs nothing; recomputing the whole ledger every minute costs the machine
 * the owner is trying to work on.
 */
const BUDGET_REPORT_REFETCH_MS = 30 * 60_000;

const STORAGE_PREFIX = "buzz:budgetsNotified:";

/** Storage key for one owner's budget dedupe set in one community. */
export function budgetNotificationStorageKey(
  pubkey: string,
  communityId: string,
): string {
  return `${STORAGE_PREFIX}${communityId}:${pubkey.trim().toLowerCase()}`;
}

function readDeliveredKeys(pubkey: string, communityId: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(
    budgetNotificationStorageKey(pubkey, communityId),
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function writeDeliveredKeys(
  pubkey: string,
  communityId: string,
  keys: readonly string[],
) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    budgetNotificationStorageKey(pubkey, communityId),
    JSON.stringify(keys),
  );
}

export function useBudgetNotifications(
  pubkey: string | undefined,
  settings: NotificationSettings,
): void {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const reportQuery = useLedgerReport(communityId, {
    refetchIntervalMs: BUDGET_REPORT_REFETCH_MS,
  });

  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  const deliver = React.useEffectEvent((signal: BudgetSignal) => {
    const current = settingsRef.current;
    // The same two gates every other needs-action alert honours: the desktop
    // master switch and the `needs_action` row in Settings. A budget belongs
    // to no channel, so channel mutes do not apply.
    if (!current.desktopEnabled || !current.slotAlertsEnabled.needs_action) {
      return;
    }
    void sendDesktopNotification({
      body: signal.body,
      // No target. A budget is not an event anyone can be routed to, and the
      // relay-authored budget head is not something the app opens; clicking
      // reveals the window, which is where the Spend screen already is.
      title: signal.title,
    }).then((didSend) => {
      if (!didSend) return;
      playNotificationSound(resolveSlotSound(current, "needs_action"));
      void requestDockBounce();
    });
  });

  const statuses = reportQuery.data?.budgetStatus;

  React.useEffect(() => {
    if (!pubkey || !communityId || !statuses) return;

    const stored = readDeliveredKeys(pubkey, communityId);
    const signals = budgetExceededSignals({
      delivered: new Set(stored),
      statuses,
    });
    if (signals.length === 0) return;

    for (const signal of signals) deliver(signal);

    // Recorded whether or not the toast actually went out, which is the same
    // no-replay rule the ask watermark keeps. Turning alerts back on later
    // must not replay every budget that was passed while they were off; the
    // Spend screen is still showing all of them.
    writeDeliveredKeys(
      pubkey,
      communityId,
      mergeBudgetNotificationKeys(
        stored,
        signals.map((signal) => signal.key),
      ),
    );
  }, [communityId, pubkey, statuses]);
}
