import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  type BlockCatalogItem,
  resolveBlockCatalogHandoff,
  useBlockCatalogQuery,
} from "@/features/blocks/blockCatalog";
import { BlocksCatalogScreen } from "@/features/blocks/ui/BlocksCatalogScreen";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";

export function BlocksRouteScreen() {
  const { activeCommunity } = useCommunities();
  const channelsQuery = useChannelsQuery();
  const channelIds = React.useMemo(
    () => (channelsQuery.data ?? []).map((channel) => channel.id),
    [channelsQuery.data],
  );
  const catalogQuery = useBlockCatalogQuery(
    activeCommunity
      ? {
          channelIds,
          communityId: activeCommunity.id,
          recentUsageAvailable: !channelsQuery.isError,
        }
      : null,
  );
  const { goChannel, goNewMessage } = useAppNavigation();

  const handleSelect = React.useCallback(
    (item: BlockCatalogItem) => {
      const handoff = resolveBlockCatalogHandoff(item);
      if (handoff.kind === "workshop") {
        void goChannel(handoff.channelId, {
          messageId: handoff.messageId,
          threadRootId: handoff.threadRootId,
        });
        return;
      }
      void goNewMessage({
        blockAddress: handoff.blockAddress,
        blockHandle: handoff.blockHandle,
        blockManifestId: handoff.blockManifestId,
      });
    },
    [goChannel, goNewMessage],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BlocksCatalogScreen
        error={catalogQuery.error instanceof Error ? catalogQuery.error : null}
        isLoading={
          activeCommunity !== null &&
          (channelsQuery.isLoading || catalogQuery.isLoading)
        }
        items={catalogQuery.data ?? []}
        onSelect={handleSelect}
      />
    </div>
  );
}
