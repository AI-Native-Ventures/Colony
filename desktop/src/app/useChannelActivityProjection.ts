import * as React from "react";

import { useAppShellReadFrontier } from "@/app/useAppShellReadFrontier";
import { useThreadActivityFeedItems } from "@/app/useThreadActivityFeedItems";
import {
  maxReadAt,
  msgContextKey,
} from "@/features/channels/readState/readStateFormat";
import type { ThreadActivityItem } from "@/features/channels/useUnreadChannels";
import { isThreadReply } from "@/features/messages/lib/threading";
import type { Channel, FeedItem, HomeFeed } from "@/shared/api/types";

type ReadTimestamp = (contextKey: string) => number | null;
type MarkChannelRead = (
  contextKey: string,
  readAt: string | null | undefined,
  options?: { topLevelOnly?: boolean },
) => void;

type UseChannelActivityProjectionOptions = {
  channels: Channel[];
  feed: HomeFeed | undefined;
  unreadFeedItemIds: ReadonlySet<string>;
  getChannelReadAt: ReadTimestamp;
  getOwnReadAt: ReadTimestamp;
  markChannelRead: MarkChannelRead;
  readStateVersion: number;
  threadActivityItems: ThreadActivityItem[];
  mutedRootIds: ReadonlySet<string>;
};

export function resolveChannelActivityFeedItemReadAt(
  item: Pick<FeedItem, "channelId" | "id">,
  getOwnReadAt: ReadTimestamp,
): number | null {
  return maxReadAt(
    getOwnReadAt(msgContextKey(item.id)),
    item.channelId ? getOwnReadAt(item.channelId) : null,
  );
}

export function useChannelActivityProjection({
  channels,
  feed,
  unreadFeedItemIds,
  getChannelReadAt,
  getOwnReadAt,
  markChannelRead,
  readStateVersion,
  threadActivityItems,
  mutedRootIds,
}: UseChannelActivityProjectionOptions) {
  // Thread and per-message read frontiers come from Colony's read-frontier
  // hook so every surface keeps folding through the channel marker (LP4 v3)
  // in exactly the same way the shell always has.
  const { getThreadReadAt, markThreadRead, getMessageReadAt, markMessageRead } =
    useAppShellReadFrontier({
      getChannelReadAt,
      getOwnReadAt,
      markChannelRead,
    });
  const getChannelActivityItemReadAt = React.useCallback(
    (item: Pick<FeedItem, "channelId" | "id">) =>
      resolveChannelActivityFeedItemReadAt(item, getOwnReadAt),
    [getOwnReadAt],
  );
  const threadActivityFeedItems = useThreadActivityFeedItems(
    threadActivityItems,
    mutedRootIds,
    channels,
  );
  const locallyUnreadFeedItems = React.useMemo(() => {
    if (!feed || unreadFeedItemIds.size === 0) return [];
    return [
      ...feed.mentions,
      ...feed.needsAction,
      ...feed.activity,
      ...feed.agentActivity,
    ].filter((item) => unreadFeedItemIds.has(item.id));
  }, [feed, unreadFeedItemIds]);
  const unreadThreadFeedItems = React.useMemo(() => {
    void readStateVersion;
    const candidatesById = new Map<string, FeedItem>(
      threadActivityFeedItems.map((item) => [item.id, item]),
    );
    for (const item of locallyUnreadFeedItems)
      candidatesById.set(item.id, item);

    return [...candidatesById.values()].filter(
      (item) =>
        isThreadReply(item.tags) &&
        (unreadFeedItemIds.has(item.id) ||
          item.createdAt > (getChannelActivityItemReadAt(item) ?? 0)),
    );
  }, [
    getChannelActivityItemReadAt,
    locallyUnreadFeedItems,
    readStateVersion,
    threadActivityFeedItems,
    unreadFeedItemIds,
  ]);
  const unreadThreadChannelIds = React.useMemo(
    () =>
      new Set(
        unreadThreadFeedItems.flatMap((item) =>
          item.channelId ? [item.channelId] : [],
        ),
      ) as ReadonlySet<string>,
    [unreadThreadFeedItems],
  );

  return {
    getThreadReadAt,
    markThreadRead,
    getMessageReadAt,
    getChannelActivityItemReadAt,
    markMessageRead,
    threadActivityFeedItems,
    locallyUnreadFeedItems,
    unreadThreadFeedItems,
    unreadThreadChannelIds,
  };
}
