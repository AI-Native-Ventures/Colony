import * as React from "react";

import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import { useProjectChannels } from "@/features/projects/useProjectChannels";
import { sortChannelsForSidebar } from "@/features/sidebar/lib/channelSortPreference";
import type { ChannelSortMode } from "@/features/sidebar/lib/channelSortPreference";
import { SidebarSection } from "@/features/sidebar/ui/SidebarSection";
import type { Channel } from "@/shared/api/types";

/**
 * Ids of the channels a project owns. Shares the `useProjectChannels` query
 * cache with the section below, so the sidebar's exclusion filters cost one
 * extra hook call and no extra fetch.
 */
export function useProjectChannelIds(): ReadonlySet<string> {
  return useProjectChannels().channelIds;
}

type ProjectChannelSectionProps = {
  activeWorkingByChannelId?: ReadonlyMap<string, ActiveChannelTurnSummary>;
  channels: Channel[];
  isActiveChannel: boolean;
  isCollapsed?: boolean;
  mutedChannelIds?: ReadonlySet<string>;
  projectChannelIds: ReadonlySet<string>;
  selectedChannelId: string | null;
  sortMode: ChannelSortMode;
  starredChannelIds?: ReadonlySet<string>;
  unreadChannelCounts: ReadonlyMap<string, number>;
  unreadChannelIds: ReadonlySet<string>;
  onMarkChannelRead: (
    channelId: string,
    lastMessageAt: string | null | undefined,
  ) => void;
  onMarkChannelUnread: (channelId: string) => void;
  onMuteChannel?: (channelId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onToggleCollapsed: () => void;
  onUnmuteChannel?: (channelId: string) => void;
};

/**
 * The sidebar's **Projects** section: the channels a project owns, shown with
 * a repository icon and the project's default branch as trailing meta.
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
  onMarkChannelRead,
  onMarkChannelUnread,
  onMuteChannel,
  onSelectChannel,
  onToggleCollapsed,
  onUnmuteChannel,
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
    <SidebarSection
      activeWorkingByChannelId={activeWorkingByChannelId}
      channelMetaById={branchByChannelId}
      isActiveChannel={isActiveChannel}
      isCollapsed={isCollapsed}
      items={items}
      mutedChannelIds={mutedChannelIds}
      onMarkChannelRead={onMarkChannelRead}
      onMarkChannelUnread={onMarkChannelUnread}
      onMuteChannel={onMuteChannel}
      onSelectChannel={onSelectChannel}
      onToggleCollapsed={onToggleCollapsed}
      onUnmuteChannel={onUnmuteChannel}
      projectChannelIds={projectChannelIds}
      selectedChannelId={selectedChannelId}
      testId="project-channel-list"
      title="Projects"
      unreadChannelCounts={unreadChannelCounts}
      unreadChannelIds={unreadChannelIds}
    />
  );
}
