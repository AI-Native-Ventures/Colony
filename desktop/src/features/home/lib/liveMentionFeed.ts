import type {
  Channel,
  FeedItem,
  HomeFeedResponse,
  RelayEvent,
} from "@/shared/api/types";
import { KIND_FORUM_COMMENT, KIND_FORUM_POST } from "@/shared/constants/kinds";

const HOME_FEED_LIMIT = 50;

type FeedChannel = Pick<Channel, "channelType" | "id" | "name">;

export const pendingLiveMentionsQueryKey = (communityId: string) =>
  ["home-feed-pending-live-mentions", communityId] as const;

function channelIdForEvent(event: RelayEvent) {
  return event.tags.find((tag) => tag[0] === "h")?.[1]?.trim() || null;
}

function toMentionItem(
  event: RelayEvent,
  channelById: ReadonlyMap<string, FeedChannel>,
): FeedItem | null {
  const channelId = channelIdForEvent(event);
  if (channelId === null) return null;
  const channel = channelById.get(channelId);
  if (
    channel?.channelType !== "forum" ||
    (event.kind !== KIND_FORUM_POST && event.kind !== KIND_FORUM_COMMENT)
  ) {
    return null;
  }
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    channelId,
    channelName: channel?.name ?? "",
    channelType: channel?.channelType,
    tags: event.tags.map((tag) => [...tag]),
    category: "mention",
  };
}

function sortMentionItems(items: readonly FeedItem[]) {
  return [...items].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

function sortAndLimitMentionItems(items: readonly FeedItem[]) {
  return sortMentionItems(items).slice(0, HOME_FEED_LIMIT);
}

export function appendPendingLiveMention(
  current: FeedItem[],
  event: RelayEvent,
  channels: readonly FeedChannel[],
): FeedItem[] {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const item = toMentionItem(event, channelById);
  if (item === null) return current;

  const itemsById = new Map(
    current.map((currentItem) => [currentItem.id, currentItem]),
  );
  itemsById.set(item.id, item);
  return sortAndLimitMentionItems([...itemsById.values()]);
}

export function mergePendingLiveMentionsIntoHomeFeed(
  current: HomeFeedResponse | undefined,
  liveItems: readonly FeedItem[],
): HomeFeedResponse | undefined {
  if (liveItems.length === 0) return current;

  const mentionsById = new Map(
    (current?.feed.mentions ?? []).map((item) => [item.id, item]),
  );
  let addedCount = 0;
  for (const item of liveItems) {
    if (!mentionsById.has(item.id)) addedCount += 1;
    mentionsById.set(item.id, item);
  }
  const pendingIds = new Set(liveItems.map((item) => item.id));
  const pendingMentions = sortAndLimitMentionItems(
    [...mentionsById.values()].filter((item) => pendingIds.has(item.id)),
  );
  const durableMentions = sortAndLimitMentionItems(
    [...mentionsById.values()].filter((item) => !pendingIds.has(item.id)),
  ).slice(0, HOME_FEED_LIMIT - pendingMentions.length);
  const mentions = sortMentionItems([...pendingMentions, ...durableMentions]);
  const latestCreatedAt = liveItems.reduce(
    (latest, item) => Math.max(latest, item.createdAt),
    0,
  );

  if (current === undefined) {
    return {
      feed: {
        mentions,
        needsAction: [],
        activity: [],
        agentActivity: [],
      },
      meta: {
        since: latestCreatedAt,
        total: mentions.length,
        generatedAt: latestCreatedAt,
      },
    };
  }

  return {
    feed: { ...current.feed, mentions },
    meta: {
      ...current.meta,
      total: current.meta.total + addedCount,
      generatedAt: Math.max(current.meta.generatedAt, latestCreatedAt),
    },
  };
}

export function reconcilePendingLiveMentions(
  durable: HomeFeedResponse,
  pendingAtStart: readonly FeedItem[],
  pendingAtCompletion: readonly FeedItem[] = pendingAtStart,
): { response: HomeFeedResponse; pending: FeedItem[] } {
  const pendingById = new Map(pendingAtStart.map((item) => [item.id, item]));
  for (const item of pendingAtCompletion) {
    pendingById.set(item.id, item);
  }
  const pending = sortAndLimitMentionItems([...pendingById.values()]);
  const durableIds = new Set(durable.feed.mentions.map((item) => item.id));
  const unresolved = pending.filter((item) => !durableIds.has(item.id));
  return {
    response:
      mergePendingLiveMentionsIntoHomeFeed(durable, unresolved) ?? durable,
    pending: unresolved,
  };
}

export async function reconcileHomeFeedRead({
  readDurable,
  readPending,
  signal,
  writePending,
}: {
  readDurable: () => Promise<HomeFeedResponse>;
  readPending: () => readonly FeedItem[];
  signal: AbortSignal;
  writePending: (pending: FeedItem[]) => void;
}): Promise<HomeFeedResponse> {
  const pendingAtStart = readPending();
  const durable = await readDurable();
  if (signal.aborted) return durable;

  const pendingAtCompletion = readPending();
  if (pendingAtStart.length === 0 && pendingAtCompletion.length === 0) {
    return durable;
  }

  const reconciled = reconcilePendingLiveMentions(
    durable,
    pendingAtStart,
    pendingAtCompletion,
  );
  writePending(reconciled.pending);
  return reconciled.response;
}
