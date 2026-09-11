import * as React from "react";

import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import {
  sortChannelsForSidebar,
  type ChannelSortMode,
} from "@/features/sidebar/lib/channelSortPreference";
import { ChannelGroupSection } from "@/features/sidebar/ui/CustomChannelSection";
import type { Channel } from "@/shared/api/types";

type StarredChannelSectionProps = {
  activeWorkingByChannelId?: ReadonlyMap<string, ActiveChannelTurnSummary>;
  isActiveChannel: boolean;
  isCollapsed: boolean;
  mutedChannelIds?: ReadonlySet<string>;
  selectedChannelId: string | null;
  sortMode: ChannelSortMode;
  starredChannelIds?: ReadonlySet<string>;
  streamChannels: Channel[];
  unreadChannelCounts: ReadonlyMap<string, number>;
  unreadChannelIds: ReadonlySet<string>;
  onDeleteChannel: (channel: Channel) => void;
  onLeaveChannel: (channel: Channel) => void;
  onMarkChannelRead: (
    channelId: string,
    lastMessageAt: string | null | undefined,
  ) => void;
  onMarkChannelUnread: (channelId: string) => void;
  onMuteChannel?: (channelId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onSortModeChange: (mode: ChannelSortMode) => void;
  onStarChannel?: (channelId: string) => void;
  onToggleCollapsed: () => void;
  onUnmuteChannel?: (channelId: string) => void;
  onUnstarChannel?: (channelId: string) => void;
};

/** The sidebar's **Starred** section: starred channels, in their own group. */
export function StarredChannelSection({
  activeWorkingByChannelId,
  isActiveChannel,
  isCollapsed,
  mutedChannelIds,
  selectedChannelId,
  sortMode,
  starredChannelIds,
  streamChannels,
  unreadChannelCounts,
  unreadChannelIds,
  onDeleteChannel,
  onLeaveChannel,
  onMarkChannelRead,
  onMarkChannelUnread,
  onMuteChannel,
  onSelectChannel,
  onSortModeChange,
  onStarChannel,
  onToggleCollapsed,
  onUnmuteChannel,
  onUnstarChannel,
}: StarredChannelSectionProps) {
  const items = React.useMemo(() => {
    if (!starredChannelIds || starredChannelIds.size === 0) return [];
    return sortChannelsForSidebar(
      streamChannels.filter((channel) => starredChannelIds.has(channel.id)),
      sortMode,
    );
  }, [sortMode, starredChannelIds, streamChannels]);

  if (items.length === 0) {
    return null;
  }

  return (
    <ChannelGroupSection
      actionsTestId="section-actions-starred"
      activeWorkingByChannelId={activeWorkingByChannelId}
      hasUnread={items.some((channel) => unreadChannelIds.has(channel.id))}
      isActiveChannel={isActiveChannel}
      isCollapsed={isCollapsed}
      items={items}
      listTestId="starred-list"
      mutedChannelIds={mutedChannelIds}
      onDeleteChannel={onDeleteChannel}
      onLeaveChannel={onLeaveChannel}
      onMarkAllRead={() => {
        for (const channel of items) {
          onMarkChannelRead(channel.id, channel.lastMessageAt);
        }
      }}
      onMarkChannelRead={onMarkChannelRead}
      onMarkChannelUnread={onMarkChannelUnread}
      onMuteChannel={onMuteChannel}
      onSelectChannel={onSelectChannel}
      onSortModeChange={onSortModeChange}
      onStarChannel={onStarChannel}
      onToggleCollapsed={onToggleCollapsed}
      onUnmuteChannel={onUnmuteChannel}
      onUnstarChannel={onUnstarChannel}
      selectedChannelId={selectedChannelId}
      sortMode={sortMode}
      starredChannelIds={starredChannelIds}
      title="Starred"
      unreadChannelCounts={unreadChannelCounts}
      unreadChannelIds={unreadChannelIds}
    />
  );
}
