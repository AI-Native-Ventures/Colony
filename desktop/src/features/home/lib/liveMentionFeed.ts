import type {
  Channel,
  FeedItem,
  HomeFeedResponse,
  RelayEvent,
} from "@/shared/api/types";
import { KIND_FORUM_COMMENT, KIND_FORUM_POST } from "@/shared/constants/kinds";

const HOME_FEED_LIMIT = 50;

type FeedChannel = Pick<Channel, "channelType" | "id" | "name">;

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

export function mergeLiveMentionsIntoHomeFeed(
  current: HomeFeedResponse | undefined,
  events: readonly RelayEvent[],
  channels: readonly FeedChannel[],
): HomeFeedResponse | undefined {
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const liveItems = events
    .map((event) => toMentionItem(event, channelById))
    .filter((item): item is FeedItem => item !== null);
  if (liveItems.length === 0) return current;

  const mentionsById = new Map(
    (current?.feed.mentions ?? []).map((item) => [item.id, item]),
  );
  let addedCount = 0;
  for (const item of liveItems) {
    if (!mentionsById.has(item.id)) addedCount += 1;
    mentionsById.set(item.id, item);
  }
  const mentions = [...mentionsById.values()]
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    )
    .slice(0, HOME_FEED_LIMIT);
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
