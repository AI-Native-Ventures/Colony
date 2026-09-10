/**
 * React binding for the canonical website head store.
 *
 * One channel-scoped query (explicit kind + `#h` filter) recovers heads on
 * reload, and one ref-counted live subscription per community+channel carries
 * head and receipt updates. Ref-counting matters: the attachment hook renders
 * for every message row, so without it a busy channel would open one REQ per
 * row. Both paths write through the verified store; the UI reads a stable
 * snapshot keyed by community + channel.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_WEBSITE_HEAD,
  KIND_WEBSITE_RECEIPT,
} from "@/shared/constants/kinds";

import {
  websiteHeadsStore,
  type WebsiteHead,
} from "./websiteHeads";

const HEAD_QUERY_STALE_MS = 10_000;

type LiveSubscription = {
  count: number;
  dispose: () => void;
};

const liveSubscriptions = new Map<string, LiveSubscription>();

function subscriptionKey(input: {
  communityId: string;
  channelId: string;
  relaySelfPubkey: string;
}): string {
  return `${input.communityId}\u0000${input.channelId}\u0000${input.relaySelfPubkey}`;
}

function acquireWebsiteChannelSubscription(input: {
  communityId: string;
  channelId: string;
  relaySelfPubkey: string;
}): () => void {
  const key = subscriptionKey(input);
  const existing = liveSubscriptions.get(key);
  if (existing) {
    existing.count += 1;
    return () => releaseWebsiteChannelSubscription(key);
  }
  let disposed = false;
  const since = Math.floor(Date.now() / 1_000);
  const pending: Array<Promise<() => Promise<void>>> = [
    relayClient.subscribeLive(
      {
        kinds: [KIND_WEBSITE_HEAD],
        "#h": [input.channelId],
        limit: 0,
        since,
      },
      (event) => {
        if (disposed) return;
        websiteHeadsStore.applyEvent(
          input.communityId,
          input.channelId,
          input.relaySelfPubkey,
          event,
        );
      },
    ),
    relayClient.subscribeLive(
      {
        kinds: [KIND_WEBSITE_RECEIPT],
        "#h": [input.channelId],
        limit: 0,
        since,
      },
      (event) => {
        if (disposed) return;
        websiteHeadsStore.applyReceipt(event, input.relaySelfPubkey);
      },
    ),
  ];
  liveSubscriptions.set(key, {
    count: 1,
    dispose: () => {
      disposed = true;
      for (const promise of pending) {
        void promise
          .then((unsubscribe) => unsubscribe())
          .catch(() => {});
      }
    },
  });
  return () => releaseWebsiteChannelSubscription(key);
}

function releaseWebsiteChannelSubscription(key: string): void {
  const entry = liveSubscriptions.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  liveSubscriptions.delete(key);
  entry.dispose();
}

/** Dispose every shared live subscription at a community boundary. */
export function resetWebsiteHeadsLiveSubscriptions(): void {
  for (const entry of [...liveSubscriptions.values()]) entry.dispose();
  liveSubscriptions.clear();
}

export function useWebsiteHeads(input: {
  communityId: string | null;
  channelId: string | null;
  relaySelfPubkey: string | null;
}): readonly WebsiteHead[] {
  const { communityId, channelId, relaySelfPubkey } = input;
  const enabled = Boolean(communityId && channelId && relaySelfPubkey);

  const query = useQuery({
    queryKey: ["website-heads", communityId, channelId, relaySelfPubkey],
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_WEBSITE_HEAD],
        "#h": [channelId as string],
        limit: 100,
      }),
    enabled,
    staleTime: HEAD_QUERY_STALE_MS,
  });

  React.useEffect(() => {
    if (
      !enabled ||
      !communityId ||
      !channelId ||
      !relaySelfPubkey ||
      !query.data
    ) {
      return;
    }
    websiteHeadsStore.applyEvents(
      communityId,
      channelId,
      relaySelfPubkey,
      query.data,
    );
  }, [channelId, communityId, enabled, query.data, relaySelfPubkey]);

  React.useEffect(() => {
    if (!enabled || !communityId || !channelId || !relaySelfPubkey) return;
    const release = acquireWebsiteChannelSubscription({
      communityId,
      channelId,
      relaySelfPubkey,
    });
    return release;
  }, [channelId, communityId, enabled, relaySelfPubkey]);

  return React.useSyncExternalStore(
    websiteHeadsStore.subscribe,
    () =>
      websiteHeadsStore.channelHeads(communityId ?? "", channelId ?? ""),
    () =>
      websiteHeadsStore.channelHeads(communityId ?? "", channelId ?? ""),
  );
}
