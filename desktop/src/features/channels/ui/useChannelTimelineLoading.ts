import * as React from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";

import { hasPersistedHydratedChannel } from "@/features/messages/lib/channelHeadCache";
import { resolveTimelineQueryLoadingState } from "@/features/messages/lib/timelineLoadingState";
import type { Channel, RelayEvent } from "@/shared/api/types";

/**
 * The channel timeline's latched loading state. Split out of
 * `ChannelScreen.tsx` to keep that file under the desktop file-size ratchet;
 * the latch itself lives in `timelineLoadingState.ts`.
 */
export function useChannelTimelineLoading({
  activeChannel,
  activeChannelId,
  messagesQuery,
  queryClient,
}: {
  activeChannel: Channel | null;
  activeChannelId: string | null;
  messagesQuery: Pick<
    UseQueryResult<RelayEvent[]>,
    "isPending" | "isFetching" | "isPlaceholderData" | "isError" | "data"
  >;
  queryClient: QueryClient;
}): boolean {
  const settledChannelIdRef = React.useRef<string | null>(null);
  const { settledChannelId, isLoading } = resolveTimelineQueryLoadingState(
    settledChannelIdRef.current,
    activeChannelId,
    {
      isEnabled:
        activeChannel !== null && activeChannel.channelType !== "forum",
      isPending: messagesQuery.isPending,
      isFetching: messagesQuery.isFetching,
      isPlaceholderData: messagesQuery.isPlaceholderData,
      dataLength: messagesQuery.data?.length ?? null,
      isError: messagesQuery.isError,
    },
    // A persisted head only counts as hydrated when it has rows to paint
    // (channelHeadCache.ts), so this bypass never settles onto an empty
    // placeholder while the authoritative refresh is still in flight.
    activeChannelId !== null &&
      hasPersistedHydratedChannel(queryClient, activeChannelId),
  );
  settledChannelIdRef.current = settledChannelId;
  return isLoading;
}
