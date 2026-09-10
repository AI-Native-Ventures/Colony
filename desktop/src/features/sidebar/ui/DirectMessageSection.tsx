import * as React from "react";

import type { ActiveChannelTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import type { ChannelSortMode } from "@/features/sidebar/lib/channelSortPreference";
import {
  SectionActionsMenu,
  SectionQuickAction,
} from "@/features/sidebar/ui/CustomChannelSection";
import {
  SidebarSection,
  type SidebarDmParticipant,
} from "@/features/sidebar/ui/SidebarSection";
import type { Channel, PresenceStatus } from "@/shared/api/types";

type DirectMessageSectionProps = {
  activeWorkingByChannelId?: ReadonlyMap<string, ActiveChannelTurnSummary>;
  channelLabels?: Record<string, string>;
  dmParticipantsByChannelId?: Record<string, SidebarDmParticipant[]>;
  isActiveChannel: boolean;
  isCollapsed?: boolean;
  items: Channel[];
  mutedChannelIds?: ReadonlySet<string>;
  presenceByChannelId?: Record<string, PresenceStatus>;
  selectedChannelId: string | null;
  sortMode: ChannelSortMode;
  unreadChannelCounts: ReadonlyMap<string, number>;
  unreadChannelIds: ReadonlySet<string>;
  onHideDm: (channelId: string) => void;
  onMarkChannelRead: (
    channelId: string,
    lastMessageAt: string | null | undefined,
  ) => void;
  onMarkChannelUnread: (channelId: string) => void;
  onMuteChannel?: (channelId: string) => void;
  onNewMessage: () => void;
  onSelectChannel: (channelId: string) => void;
  onSortModeChange: (mode: ChannelSortMode) => void;
  onToggleCollapsed: () => void;
  onUnmuteChannel?: (channelId: string) => void;
};

/** The sidebar's **Direct messages** section and its section actions menu. */
export function DirectMessageSection({
  activeWorkingByChannelId,
  channelLabels,
  dmParticipantsByChannelId,
  isActiveChannel,
  isCollapsed,
  items,
  mutedChannelIds,
  presenceByChannelId,
  selectedChannelId,
  sortMode,
  unreadChannelCounts,
  unreadChannelIds,
  onHideDm,
  onMarkChannelRead,
  onMarkChannelUnread,
  onMuteChannel,
  onNewMessage,
  onSelectChannel,
  onSortModeChange,
  onToggleCollapsed,
  onUnmuteChannel,
}: DirectMessageSectionProps) {
  const [actionsMenuOpen, setActionsMenuOpen] = React.useState(false);

  return (
    <SidebarSection
      action={
        <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5">
          <SectionQuickAction
            label="New message"
            onClick={onNewMessage}
            testId="section-actions-dms-quick-create"
          />
          <SectionActionsMenu
            sectionLabel="direct messages"
            testId="section-actions-dms"
            onOpenChange={setActionsMenuOpen}
            onNewMessage={onNewMessage}
            sortMode={sortMode}
            onSortModeChange={onSortModeChange}
          />
        </div>
      }
      activeWorkingByChannelId={activeWorkingByChannelId}
      channelLabels={channelLabels}
      dmParticipantsByChannelId={dmParticipantsByChannelId}
      isActiveChannel={isActiveChannel}
      isCollapsed={isCollapsed}
      items={items}
      mutedChannelIds={mutedChannelIds}
      onHideDm={onHideDm}
      onMarkChannelRead={onMarkChannelRead}
      onMarkChannelUnread={onMarkChannelUnread}
      onMuteChannel={onMuteChannel}
      onSelectChannel={onSelectChannel}
      onToggleCollapsed={onToggleCollapsed}
      onUnmuteChannel={onUnmuteChannel}
      presenceByChannelId={presenceByChannelId}
      sectionActionsOpen={actionsMenuOpen}
      selectedChannelId={selectedChannelId}
      testId="dm-list"
      title="Direct messages"
      unreadChannelCounts={unreadChannelCounts}
      unreadChannelIds={unreadChannelIds}
    />
  );
}
