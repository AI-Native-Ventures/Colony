import * as React from "react";

import {
  consumePendingCommunityRestore,
  loadCommunityDestination,
  saveCommunityDestination,
} from "@/features/communities/communityNavigationStorage";
import type { Channel } from "@/shared/api/types";

type CommunityDestinationRestoreArgs = {
  activeCommunityId: string | undefined;
  channelsReady: boolean;
  channelsDataUpdatedAt: number;
  sidebarChannels: Channel[];
  isHomeView: boolean;
  goChannel: (channelId: string, options?: { replace?: boolean }) => unknown;
  goHome: (options?: { replace?: boolean }) => unknown;
};

/**
 * Restore the remembered channel destination after an explicit community
 * transition, exactly once per community mount. Cold boots and reconnect
 * remounts must preserve the route the user explicitly opened, so this runs
 * only while consuming a pending restore marker.
 */
export function useCommunityDestinationRestore({
  activeCommunityId,
  channelsReady,
  channelsDataUpdatedAt,
  sidebarChannels,
  isHomeView,
  goChannel,
  goHome,
}: CommunityDestinationRestoreArgs) {
  const hasRestoredCommunityDestinationRef = React.useRef(false);
  React.useEffect(() => {
    if (
      hasRestoredCommunityDestinationRef.current ||
      !channelsReady ||
      channelsDataUpdatedAt === 0 ||
      !activeCommunityId
    ) {
      return;
    }
    hasRestoredCommunityDestinationRef.current = true;
    // Restoration belongs to an explicit community transition. Cold boot and
    // reconnect remounts must preserve the route the user explicitly opened.
    if (!consumePendingCommunityRestore(activeCommunityId)) {
      return;
    }

    const destination = loadCommunityDestination(activeCommunityId);
    if (!destination || destination.kind === "home") {
      return;
    }

    const channelIsAvailable = sidebarChannels.some(
      (channel) => channel.id === destination.channelId,
    );
    if (!channelIsAvailable) {
      saveCommunityDestination(activeCommunityId, { kind: "home" });
      void goHome({ replace: true });
      return;
    }

    // The normal switch path writes the remembered channel into the hash before
    // the target community mounts, so no intermediate Inbox frame is painted.
    // Older transition callers may still arrive at neutral Home; repair those.
    if (isHomeView) {
      void goChannel(destination.channelId, { replace: true });
    }
  }, [
    activeCommunityId,
    channelsDataUpdatedAt,
    channelsReady,
    goChannel,
    goHome,
    isHomeView,
    sidebarChannels,
  ]);
}
