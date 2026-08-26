import * as React from "react";

import {
  canPreviewUnreadDm,
  preferredUnreadTarget,
  type UnreadDmPreview,
} from "@/features/sidebar/ui/MoreUnreadButton";
import { sortDmChannelsForSidebar } from "@/features/sidebar/lib/dmSidebarSort";
import type { SidebarDmParticipant } from "@/features/sidebar/ui/SidebarSection";
import type { Channel } from "@/shared/api/types";
import type { ChannelSortMode } from "@/features/sidebar/lib/channelSortPreference";

/**
 * Names the unread direct messages below the viewport so the overflow pill can
 * show who is waiting, and picks the DM the pill jumps to first (#6842).
 *
 * A preview is only offered for a resolved one-to-one conversation: a group DM
 * has no single face to show, and an unresolved participant would put a
 * placeholder avatar on the pill.
 */
export function useUnreadDmPreviews({
  directMessages,
  dmChannelLabels,
  dmParticipantsByChannelId,
  dmSortMode,
  unreadBelowChannelIds,
}: {
  directMessages: Channel[];
  dmChannelLabels: Record<string, string>;
  dmParticipantsByChannelId: Record<string, SidebarDmParticipant[]>;
  dmSortMode: ChannelSortMode;
  unreadBelowChannelIds: string[];
}): {
  nextUnreadDmBelowId: string | undefined;
  sortedDirectMessages: Channel[];
  unreadDmPreviewsBelow: UnreadDmPreview[];
} {
  const sortedDirectMessages = React.useMemo(
    () => sortDmChannelsForSidebar(directMessages, dmChannelLabels, dmSortMode),
    [directMessages, dmChannelLabels, dmSortMode],
  );
  const unreadDmPreviewsBelow = React.useMemo(
    () =>
      unreadBelowChannelIds.flatMap((channelId) => {
        const channel = directMessages.find(
          (candidate) => candidate.id === channelId,
        );
        const participants = dmParticipantsByChannelId[channelId];
        const participant = participants?.[0];
        if (
          !channel ||
          !participant ||
          !canPreviewUnreadDm(
            channel.participantPubkeys.length,
            participants?.length ?? 0,
          )
        ) {
          return [];
        }
        return [
          {
            accessibleLabel: participant.label,
            avatarUrl: participant.avatarUrl,
            channelId,
            label: dmChannelLabels[channelId] ?? participant.label,
          },
        ];
      }),
    [
      directMessages,
      dmChannelLabels,
      dmParticipantsByChannelId,
      unreadBelowChannelIds,
    ],
  );
  const unreadDmChannelIds = React.useMemo(
    () => new Set(directMessages.map(({ id }) => id)),
    [directMessages],
  );
  return {
    nextUnreadDmBelowId: preferredUnreadTarget(
      unreadBelowChannelIds,
      unreadDmChannelIds,
    ),
    sortedDirectMessages,
    unreadDmPreviewsBelow,
  };
}
