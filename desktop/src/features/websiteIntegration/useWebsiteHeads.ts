/**
 * React binding for the canonical website head store.
 *
 * Every message row mounts this hook, so network work is not owned here: a
 * module-level loader guarantees exactly one query per
 * (community, channel, relay-self), joins concurrent mounts on one in-flight
 * promise, reuses a fresh load for a quiet window, and backs off on relay
 * rate limits without surfacing an error. One ref-counted live subscription
 * per key carries head and receipt updates. The UI reads a stable snapshot
 * keyed by community + channel.
 */

import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_WEBSITE_HEAD,
  KIND_WEBSITE_RECEIPT,
} from "@/shared/constants/kinds";

import { websiteHeadsStore, type WebsiteHead } from "./websiteHeads";
import {
  createWebsiteHeadsLoader,
  type WebsiteHeadsLoaderInput,
} from "./websiteHeadsLoaderCore";

type LiveSubscription = {
  count: number;
  dispose: () => void;
};

const liveSubscriptions = new Map<string, LiveSubscription>();

export const websiteHeadsLoader = createWebsiteHeadsLoader({
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
  applyEvents: (input, events) =>
    websiteHeadsStore.applyEvents(
      input.communityId,
      input.channelId,
      input.relaySelfPubkey,
      events,
    ),
  now: () => Date.now(),
  setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimer: (timer) => globalThis.clearTimeout(timer),
});

function subscriptionKey(input: WebsiteHeadsLoaderInput): string {
  return `${input.communityId}\u0000${input.channelId}\u0000${input.relaySelfPubkey}`;
}

function acquireWebsiteChannelSubscription(
  input: WebsiteHeadsLoaderInput,
): () => void {
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
        void promise.then((unsubscribe) => unsubscribe()).catch(() => {});
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

/**
 * Dispose every shared live subscription and pending load at a community
 * boundary. The store reset drops the data; this drops the transport work.
 */
export function resetWebsiteHeadsLiveSubscriptions(): void {
  for (const entry of [...liveSubscriptions.values()]) entry.dispose();
  liveSubscriptions.clear();
  websiteHeadsLoader.reset();
}

export function useWebsiteHeads(input: {
  communityId: string | null;
  channelId: string | null;
  relaySelfPubkey: string | null;
}): readonly WebsiteHead[] {
  const { communityId, channelId, relaySelfPubkey } = input;
  const enabled = Boolean(communityId && channelId && relaySelfPubkey);

  React.useEffect(() => {
    if (!enabled || !communityId || !channelId || !relaySelfPubkey) return;
    void websiteHeadsLoader.ensure({
      communityId,
      channelId,
      relaySelfPubkey,
    });
  }, [channelId, communityId, enabled, relaySelfPubkey]);

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
    () => websiteHeadsStore.channelHeads(communityId ?? "", channelId ?? ""),
    () => websiteHeadsStore.channelHeads(communityId ?? "", channelId ?? ""),
  );
}
