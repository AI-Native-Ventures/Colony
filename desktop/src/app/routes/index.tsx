import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { homeSurface, validateHomeSearch } from "@/app/routes/homeSearch";
import { useChannelsQuery } from "@/features/channels/hooks";
import { HomeActionsPane } from "@/features/home/ui/HomeActionsPane";
import { HomeScreen } from "@/features/home/ui/HomeScreen";
import { HomeTopTabs } from "@/features/home/ui/HomeTopTabs";
import {
  consumePendingWelcomeChannel,
  WELCOME_CHANNEL_READY_EVENT,
} from "@/features/onboarding/welcome";
import { useIdentityQuery } from "@/shared/api/hooks";

export const Route = createFileRoute("/")({
  validateSearch: validateHomeSearch,
  component: HomeRouteComponent,
});

function HomeRouteComponent() {
  const search = Route.useSearch();
  const { goChannel } = useAppNavigation();
  const channelsQuery = useChannelsQuery();
  const identityQuery = useIdentityQuery();
  const channels = channelsQuery.data ?? [];
  const availableChannelIds = React.useMemo(
    () => new Set(channels.map((channel) => channel.id)),
    [channels],
  );
  const availableChannelIdsRef = React.useRef(availableChannelIds);
  const openPendingWelcomeChannel = React.useCallback(
    (ids: ReadonlySet<string>) => {
      const welcomeChannelId = consumePendingWelcomeChannel(ids);
      if (!welcomeChannelId) {
        return;
      }

      void goChannel(welcomeChannelId, { replace: true });
    },
    [goChannel],
  );

  React.useEffect(() => {
    availableChannelIdsRef.current = availableChannelIds;
  }, [availableChannelIds]);

  React.useEffect(() => {
    function handleWelcomeChannelReady() {
      openPendingWelcomeChannel(availableChannelIdsRef.current);
    }

    window.addEventListener(
      WELCOME_CHANNEL_READY_EVENT,
      handleWelcomeChannelReady,
    );
    return () => {
      window.removeEventListener(
        WELCOME_CHANNEL_READY_EVENT,
        handleWelcomeChannelReady,
      );
    };
  }, [openPendingWelcomeChannel]);

  React.useEffect(() => {
    openPendingWelcomeChannel(availableChannelIds);
  }, [availableChannelIds, openPendingWelcomeChannel]);

  const view = homeSurface(search);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <HomeTopTabs view={view} />
      {view === "actions" ? (
        <HomeActionsPane search={search} />
      ) : (
        <HomeScreen
          availableChannelIds={availableChannelIds}
          currentPubkey={identityQuery.data?.pubkey}
          onOpenContext={(channelId, messageId, threadRootId) => {
            void goChannel(channelId, { messageId, threadRootId });
          }}
        />
      )}
    </div>
  );
}
