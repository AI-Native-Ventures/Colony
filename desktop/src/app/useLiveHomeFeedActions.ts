import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { remindersQueryKey } from "@/features/reminders/hooks";
import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_APPROVAL_REQUEST,
  KIND_BLOCK_RECEIPT,
  KIND_EVENT_REMINDER,
  KIND_REMINDER,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

const HOME_FEED_ACTION_KINDS = [
  KIND_APPROVAL_REQUEST,
  KIND_REMINDER,
  KIND_STREAM_MESSAGE,
] as const;
const LIVE_HOME_FEED_RETRY_BASE_MS = 1_000;
const LIVE_HOME_FEED_RETRY_MAX_MS = 30_000;

export function homeFeedLiveFilters(pubkey: string, since: number) {
  return {
    action: {
      kinds: [...HOME_FEED_ACTION_KINDS],
      "#p": [pubkey],
      limit: 50,
      since,
    },
    receipt: {
      kinds: [KIND_BLOCK_RECEIPT],
      limit: 50,
      since,
    },
    reminder: {
      authors: [pubkey],
      kinds: [KIND_EVENT_REMINDER],
      limit: 50,
      since,
    },
  };
}

/**
 * Channel-scoped live filters for a single member channel. The relay's
 * scoping invariant is symmetric: global (channel-less) subscriptions never
 * receive channel-scoped events, and channel-scoped subscriptions never
 * receive global events. Block receipts, actions, and stream messages are
 * channel-scoped (they carry an `h` tag), so the home feed must subscribe per
 * member channel to see them live instead of waiting for the 30s poll.
 *
 * Reminders (kind 30300, authored by self) are global events and are left to
 * the global `reminder` filter in {@link homeFeedLiveFilters}.
 */
export function homeFeedChannelLiveFilters(
  channelId: string,
  pubkey: string,
  since: number,
) {
  const global = homeFeedLiveFilters(pubkey, since);
  return {
    action: {
      ...global.action,
      "#h": [channelId],
    },
    receipt: {
      ...global.receipt,
      "#h": [channelId],
    },
  };
}

export function useLiveHomeFeedActions(
  pubkey: string | undefined,
  onHomeFeedEvent: () => void,
  memberChannelIds: string[] = [],
) {
  const queryClient = useQueryClient();
  // Stable primitive key so a fresh-but-equal member list (e.g. while the
  // channels query is loading) does not churn live subscriptions.
  const memberChannelIdsKey = React.useMemo(
    () => [...new Set(memberChannelIds)].sort().join(","),
    [memberChannelIds],
  );
  const handleLiveHomeFeedEvent = React.useEffectEvent(() => {
    onHomeFeedEvent();
  });
  const handleLiveReminderEvent = React.useEffectEvent(
    (normalizedPubkey: string) => {
      onHomeFeedEvent();
      void queryClient.invalidateQueries({
        queryKey: remindersQueryKey(normalizedPubkey),
      });
    },
  );

  React.useEffect(() => {
    const normalizedPubkey = pubkey?.trim().toLowerCase() ?? "";
    if (!normalizedPubkey) {
      return;
    }

    let isCancelled = false;
    let disposers: Array<() => Promise<void>> = [];
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let retryAttempt = 0;
    const since = Math.floor(Date.now() / 1_000);
    const memberChannelIdsAtStart = memberChannelIdsKey
      ? memberChannelIdsKey.split(",")
      : [];

    const disposeAll = (currentDisposers: Array<() => Promise<void>>) => {
      void Promise.allSettled(currentDisposers.map((dispose) => dispose()));
    };
    const scheduleRetry = () => {
      if (isCancelled) {
        return;
      }

      const delay = Math.min(
        LIVE_HOME_FEED_RETRY_MAX_MS,
        LIVE_HOME_FEED_RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 5),
      );
      retryAttempt += 1;
      retryTimer = globalThis.setTimeout(startSubscriptions, delay);
    };
    const startSubscriptions = () => {
      if (isCancelled) {
        return;
      }
      const filters = homeFeedLiveFilters(normalizedPubkey, since);

      // The relay scoping invariant never delivers channel-scoped events
      // (receipts, actions, mentions) to global subscriptions, so subscribe
      // per member channel to keep the home feed live instead of waiting for
      // the 30s poll. Global subscriptions are kept alongside: the feed can
      // also surface community-global events (channel-less mentions), and the
      // two scopes are disjoint, so no event is delivered twice.
      const subscriptions: Array<Promise<() => Promise<void>>> = [
        relayClient.subscribeLive(filters.action, handleLiveHomeFeedEvent),
        relayClient.subscribeLive(filters.receipt, handleLiveHomeFeedEvent),
        relayClient.subscribeLive(filters.reminder, () => {
          handleLiveReminderEvent(normalizedPubkey);
        }),
        ...memberChannelIdsAtStart.flatMap((channelId) => {
          const scoped = homeFeedChannelLiveFilters(
            channelId,
            normalizedPubkey,
            since,
          );
          return [
            relayClient.subscribeLive(scoped.action, handleLiveHomeFeedEvent),
            relayClient.subscribeLive(scoped.receipt, handleLiveHomeFeedEvent),
          ];
        }),
      ];

      void Promise.allSettled(subscriptions).then((results) => {
        const nextDisposers = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const rejectedResults = results.filter(
          (result) => result.status === "rejected",
        );
        for (const result of rejectedResults) {
          console.error(
            "Failed to subscribe to live home feed actions; retrying",
            result.reason,
          );
        }

        if (isCancelled) {
          disposeAll(nextDisposers);
          return;
        }

        if (rejectedResults.length > 0 || nextDisposers.length === 0) {
          disposeAll(nextDisposers);
          scheduleRetry();
          return;
        }

        retryAttempt = 0;
        disposers = nextDisposers;
      });
    };

    startSubscriptions();

    return () => {
      isCancelled = true;
      if (retryTimer !== null) {
        globalThis.clearTimeout(retryTimer);
      }
      const currentDisposers = disposers;
      disposers = [];
      disposeAll(currentDisposers);
    };
  }, [memberChannelIdsKey, pubkey]);
}
