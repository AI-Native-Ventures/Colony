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
const communityLiveSubscriptions = new Map<string, LiveSubscription>();

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

function channelIdFromHeadTags(tags: readonly string[][]): string | null {
  const matches = tags.filter(
    (tag) => tag[0] === "h" && tag.length === 2 && tag[1],
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function communitySubscriptionKey(input: {
  communityId: string;
  relaySelfPubkey: string;
}): string {
  return `${input.communityId}\u0000${input.relaySelfPubkey}`;
}

/**
 * Keep the verified Website head store warm for the active community even
 * when no timeline card is mounted. The channel-specific subscriptions below
 * remain for existing attachment consumers; this ref-counted subscription is
 * the app-level path used by background evidence grants.
 */
export function acquireWebsiteCommunitySubscription(input: {
  communityId: string;
  relaySelfPubkey: string;
}): () => void {
  const key = communitySubscriptionKey(input);
  const existing = communityLiveSubscriptions.get(key);
  if (existing) {
    existing.count += 1;
    return () => releaseWebsiteCommunitySubscription(key);
  }

  let disposed = false;
  const since = Math.floor(Date.now() / 1_000);
  const pending: Array<Promise<() => Promise<void>>> = [
    relayClient.subscribeLive(
      {
        kinds: [KIND_WEBSITE_HEAD],
        limit: 0,
        since,
      },
      (event) => {
        if (disposed) return;
        const channelId = channelIdFromHeadTags(event.tags);
        if (!channelId) return;
        websiteHeadsStore.applyEvent(
          input.communityId,
          channelId,
          input.relaySelfPubkey,
          event,
        );
      },
    ),
    relayClient.subscribeLive(
      {
        kinds: [KIND_WEBSITE_RECEIPT],
        limit: 0,
        since,
      },
      (event) => {
        if (disposed) return;
        websiteHeadsStore.applyReceipt(event, input.relaySelfPubkey);
      },
    ),
  ];
  communityLiveSubscriptions.set(key, {
    count: 1,
    dispose: () => {
      disposed = true;
      for (const promise of pending) {
        void promise.then((unsubscribe) => unsubscribe()).catch(() => {});
      }
    },
  });
  return () => releaseWebsiteCommunitySubscription(key);
}

function releaseWebsiteCommunitySubscription(key: string): void {
  const entry = communityLiveSubscriptions.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count > 0) return;
  communityLiveSubscriptions.delete(key);
  entry.dispose();
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
  for (const entry of [...communityLiveSubscriptions.values()]) entry.dispose();
  communityLiveSubscriptions.clear();
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

const EMPTY_COMMUNITY_HEADS: readonly WebsiteHead[] = [];

/**
 * App-level binding for verified Website heads across the member channels of
 * one active community. It shares the canonical store and loader with the
 * attachment hook, but its lifetime is independent of any rendered message.
 */
export function useWebsiteHeadsForCommunity(input: {
  communityId: string | null;
  channelIds: readonly string[];
  relaySelfPubkey: string | null;
}): readonly WebsiteHead[] {
  const { communityId, channelIds, relaySelfPubkey } = input;
  const normalizedChannelIds = React.useMemo(
    () =>
      [...new Set(channelIds.map((channelId) => channelId.trim().toLowerCase()))]
        .filter(Boolean)
        .sort(),
    [channelIds],
  );
  const enabled = Boolean(communityId && relaySelfPubkey);
  const [storeRevision, setStoreRevision] = React.useState(0);

  React.useEffect(() => {
    if (!enabled || !communityId || !relaySelfPubkey) return;
    let disposed = false;
    const unsubscribe = websiteHeadsStore.subscribe(() => {
      if (!disposed) setStoreRevision((revision) => revision + 1);
    });
    const release = acquireWebsiteCommunitySubscription({
      communityId,
      relaySelfPubkey,
    });
    return () => {
      disposed = true;
      unsubscribe();
      release();
    };
  }, [communityId, enabled, relaySelfPubkey]);

  React.useEffect(() => {
    if (!enabled || !communityId || !relaySelfPubkey) return;
    let disposed = false;
    void Promise.all(
      normalizedChannelIds.map((channelId) =>
        websiteHeadsLoader.ensure({
          communityId,
          channelId,
          relaySelfPubkey,
        }),
      ),
    ).then(() => {
      if (!disposed) setStoreRevision((revision) => revision + 1);
    });
    return () => {
      disposed = true;
    };
  }, [
    communityId,
    enabled,
    normalizedChannelIds,
    relaySelfPubkey,
  ]);

  return React.useMemo(() => {
    if (!communityId) return EMPTY_COMMUNITY_HEADS;
    return normalizedChannelIds.flatMap((channelId) =>
      websiteHeadsStore.channelHeads(communityId, channelId),
    );
  }, [communityId, normalizedChannelIds, storeRevision]);
}
