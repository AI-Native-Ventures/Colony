import * as React from "react";

import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import { useProjectChannels } from "@/features/projects/useProjectChannels";
import { sortChannelsForSidebar } from "@/features/sidebar/lib/channelSortPreference";
import type { ChannelSortMode } from "@/features/sidebar/lib/channelSortPreference";
import { ChannelGroupSection } from "@/features/sidebar/ui/CustomChannelSection";
import type { Channel } from "@/shared/api/types";

/**
 * Which channels a project owns, and whether that is known yet. Shares the
 * `useProjectChannels` query cache with the section below, so the sidebar's
 * exclusion filters cost one extra hook call and no extra fetch.
 */
export function useProjectChannelPlacement(): {
  channelIds: ReadonlySet<string>;
  settled: boolean;
} {
  const { channelIds, settled } = useProjectChannels();
  return { channelIds, settled };
}

type ProjectChannelSectionProps = {
  activeWorkingByChannelId?: ReadonlyMap<string, ActiveChannelTurnSummary>;
  channels: Channel[];
  isActiveChannel: boolean;
  isCollapsed: boolean;
  mutedChannelIds?: ReadonlySet<string>;
  projectChannelIds: ReadonlySet<string>;
  selectedChannelId: string | null;
  sortMode: ChannelSortMode;
  starredChannelIds?: ReadonlySet<string>;
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
  onStarChannel?: (channelId: string) => void;
  onToggleCollapsed: () => void;
  onUnmuteChannel?: (channelId: string) => void;
  onUnstarChannel?: (channelId: string) => void;
};

/**
 * The sidebar's **Projects** section: the channels a project owns, shown with
 * a repository icon and the project's default branch as trailing meta.
 *
 * It is the same `ChannelGroupSection` every other channel group uses, so a
 * project channel keeps the standard row, context menu (star, mute, archive,
 * delete, leave) and selected/hover styling — only the icon and the trailing
 * branch differ. Like Forums, its rows are not draggable: section membership
 * here follows the project link, not a drag.
 *
 * These channels are removed from the plain channel sections by the caller. A
 * starred one stays under Starred instead of appearing twice.
 */
export function ProjectChannelSection({
  activeWorkingByChannelId,
  channels,
  isActiveChannel,
  isCollapsed,
  mutedChannelIds,
  projectChannelIds,
  selectedChannelId,
  sortMode,
  starredChannelIds,
  unreadChannelCounts,
  unreadChannelIds,
  onDeleteChannel,
  onLeaveChannel,
  onMarkChannelRead,
  onMarkChannelUnread,
  onMuteChannel,
  onSelectChannel,
  onStarChannel,
  onToggleCollapsed,
  onUnmuteChannel,
  onUnstarChannel,
}: ProjectChannelSectionProps) {
  const { branchByChannelId } = useProjectChannels();
  const items = React.useMemo(
    () =>
      sortChannelsForSidebar(
        channels.filter(
          (channel) =>
            channel.channelType !== "dm" &&
            projectChannelIds.has(channel.id) &&
            !starredChannelIds?.has(channel.id),
        ),
        sortMode,
      ),
    [channels, projectChannelIds, sortMode, starredChannelIds],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <ChannelGroupSection
      activeWorkingByChannelId={activeWorkingByChannelId}
      channelMetaById={branchByChannelId}
      hasUnread={items.some((channel) => unreadChannelIds.has(channel.id))}
      isActiveChannel={isActiveChannel}
      isCollapsed={isCollapsed}
      items={items}
      listTestId="project-channel-list"
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
      onStarChannel={onStarChannel}
      onToggleCollapsed={onToggleCollapsed}
      onUnmuteChannel={onUnmuteChannel}
      onUnstarChannel={onUnstarChannel}
      projectChannelIds={projectChannelIds}
      selectedChannelId={selectedChannelId}
      starredChannelIds={starredChannelIds}
      title="Projects"
      unreadChannelCounts={unreadChannelCounts}
      unreadChannelIds={unreadChannelIds}
    />
  );
}
