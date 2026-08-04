import * as React from "react";

import { msgContextKey } from "@/features/channels/readState/readStateFormat";

type ReadFrontierOptions = {
  getChannelReadAt: (contextKey: string) => number | null;
  getOwnReadAt: (contextKey: string) => number | null;
  markChannelRead: (contextKey: string, readAt: string) => void;
};

/**
 * Thread and per-message read frontiers derived from the shared NIP-RS
 * channel read state.
 *
 * Both fold through the channel marker (LP4 v3): a channel read clears every
 * thread and message older than the top-level frontier, so a thread the user
 * never opened does not stay unread forever after they read the channel.
 */
export function useAppShellReadFrontier({
  getChannelReadAt,
  getOwnReadAt,
  markChannelRead,
}: ReadFrontierOptions) {
  const getThreadReadAt = React.useCallback(
    (rootId: string, channelId?: string | null) => {
      const threadReadAt = getOwnReadAt(`thread:${rootId}`);
      if (!channelId) return threadReadAt;

      const channelReadAt = getChannelReadAt(channelId);
      if (threadReadAt === null) return channelReadAt;
      if (channelReadAt === null) return threadReadAt;
      return Math.max(threadReadAt, channelReadAt);
    },
    [getChannelReadAt, getOwnReadAt],
  );

  const markThreadRead = React.useCallback(
    (rootId: string, timestamp: number) => {
      markChannelRead(
        `thread:${rootId}`,
        new Date(timestamp * 1_000).toISOString(),
      );
    },
    [markChannelRead],
  );

  const getMessageReadAt = React.useCallback(
    (messageId: string) => getChannelReadAt(msgContextKey(messageId)),
    [getChannelReadAt],
  );

  const markMessageRead = React.useCallback(
    (messageId: string, timestamp: number) =>
      markChannelRead(
        msgContextKey(messageId),
        new Date(timestamp * 1_000).toISOString(),
      ),
    [markChannelRead],
  );

  return { getMessageReadAt, getThreadReadAt, markMessageRead, markThreadRead };
}
