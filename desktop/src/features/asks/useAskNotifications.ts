import * as React from "react";

import type { OpenAsk } from "@/features/asks/lib/askEvent";
import {
  askArrivalDedupeKeys,
  askNotificationSignals,
  mergeAskNotificationKeys,
  type AskNotificationSignal,
} from "@/features/asks/lib/askNotificationSignals";
import type { AskState } from "@/features/asks/lib/askState";
import { useAskStates } from "@/features/asks/useAskStates";
import { useOpenAsks } from "@/features/asks/useOpenAsks";
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
import { KIND_ASK } from "@/shared/constants/kinds";

/**
 * Desktop notifications for asks.
 *
 * Asks were the one genuinely urgent thing in the app that made no sound and
 * showed no toast: a founder had to remember to go and look, and a decision
 * could be taken from them by a relay timer they never saw.
 *
 * This follows `useReminderNotifications` exactly rather than inventing a
 * second mechanism. Asks do not travel through the Home feed (they are relay
 * events, not `HomeFeedResponse` rows), so `useFeedDesktopNotifications`
 * cannot carry them, but everything downstream is shared: the same
 * `sendDesktopNotification`, the same `needs_action` sound slot, the same
 * `desktopEnabled` master switch, and the same dock bounce.
 *
 * Mount once, at app level.
 */

const ASK_NOTIFICATION_POLL_INTERVAL_MS = 30_000;
const STORAGE_PREFIX = "buzz:asksNotified:";

/** Storage key for one owner's ask dedupe set in one community. */
export function askNotificationStorageKey(
  pubkey: string,
  communityId: string,
): string {
  return `${STORAGE_PREFIX}${communityId}:${pubkey.trim().toLowerCase()}`;
}

function readDeliveredKeys(pubkey: string, communityId: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(
    askNotificationStorageKey(pubkey, communityId),
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
    askNotificationStorageKey(pubkey, communityId),
    JSON.stringify(keys),
  );
}

export function useAskNotifications(
  pubkey: string | undefined,
  settings: NotificationSettings,
): void {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const { asks, isLoading } = useOpenAsks();
  const askIds = React.useMemo(() => asks.map((ask) => ask.id), [asks]);
  const { states } = useAskStates(askIds);

  const asksRef = React.useRef<readonly OpenAsk[]>(asks);
  asksRef.current = asks;
  const statesRef = React.useRef<ReadonlyMap<string, AskState>>(states);
  statesRef.current = states;
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  // The ask query is still loading on mount and after a community switch, so
  // `asks` is []. Seeding the dedupe set from an unresolved query would mark
  // nothing as seen and then announce every existing ask on the next pass, so
  // the first pass waits for a resolved read.
  const queryResolvedRef = React.useRef(false);
  const scopeRef = React.useRef({ communityId, pubkey });
  if (
    scopeRef.current.communityId !== communityId ||
    scopeRef.current.pubkey !== pubkey
  ) {
    scopeRef.current = { communityId, pubkey };
    queryResolvedRef.current = false;
  }
  if (!isLoading) queryResolvedRef.current = true;

  const deliver = React.useEffectEvent((signal: AskNotificationSignal) => {
    const current = settingsRef.current;
    // Exactly the gates every other needs-action alert honours: the desktop
    // master switch and the `needs_action` per-event row in Settings. Channel
    // mutes do not apply, since an ask is addressed to a person and belongs
    // to no channel.
    if (!current.desktopEnabled || !current.slotAlertsEnabled.needs_action) {
      return;
    }
    void sendDesktopNotification({
      title: signal.title,
      body: signal.body,
      // No channelId on purpose. The notification router sends a target with
      // no channel Home, which is where the ask's inbox row and answer card
      // live. Routing to the ask's origin channel instead would land the
      // owner in a thread rather than on the thing they have to answer.
      target: {
        channelId: null,
        eventId: signal.askId,
        kind: KIND_ASK,
      },
    }).then((didSend) => {
      if (!didSend) return;
      playNotificationSound(resolveSlotSound(current, "needs_action"));
      void requestDockBounce();
    });
  });

  React.useEffect(() => {
    if (!pubkey || !communityId) return;

    let seeded = false;

    const check = () => {
      if (!queryResolvedRef.current) return;

      const stored = readDeliveredKeys(pubkey, communityId);

      if (!seeded) {
        seeded = true;
        // First resolved pass in this scope: everything already sitting in
        // the inbox counts as known, so launching the app is silent. Deadline
        // keys are not seeded, so an ask genuinely about to expire still
        // warns on the very next pass.
        const merged = mergeAskNotificationKeys(
          stored,
          askArrivalDedupeKeys(asksRef.current),
        );
        if (merged !== stored) {
          writeDeliveredKeys(pubkey, communityId, merged);
        }
        return;
      }

      const signals = askNotificationSignals({
        asks: asksRef.current,
        states: statesRef.current,
        nowMs: Date.now(),
        delivered: new Set(stored),
      });
      if (signals.length === 0) return;

      for (const signal of signals) deliver(signal);

      // Recorded whether or not the toast actually went out. Re-enabling
      // alerts later must not replay a backlog of asks that arrived while
      // they were off, which is the same no-replay rule the reminder
      // watermark keeps. A suppressed ask is still in the inbox and the badge.
      writeDeliveredKeys(
        pubkey,
        communityId,
        mergeAskNotificationKeys(
          stored,
          signals.map((signal) => signal.key),
        ),
      );
    };

    check();
    const interval = window.setInterval(
      check,
      ASK_NOTIFICATION_POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [communityId, pubkey]);
}
