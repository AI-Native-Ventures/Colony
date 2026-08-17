import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  type BlockCatalogItem,
  resolveBlockCatalogHandoff,
  useBlockCatalogQuery,
} from "@/features/blocks/blockCatalog";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { SettingsSectionHeader } from "@/features/settings/ui/SettingsSectionHeader";

import { BlocksCatalogList } from "./BlocksCatalogList";

/**
 * The Blocks catalog, as a Settings section.
 *
 * Picking a Block is a navigation into chat, which leaves Settings: the
 * catalog is a place to look up what exists, and the work itself happens in a
 * conversation.
 */
export function BlocksSettingsCard() {
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
    <section className="min-w-0" data-testid="blocks-catalog-page">
      <SettingsSectionHeader
        description="The reusable views agents can place inside a conversation. Open one to continue working on it in chat."
        title="Blocks"
      />

      <BlocksCatalogList
        error={catalogQuery.error instanceof Error ? catalogQuery.error : null}
        isLoading={
          activeCommunity !== null &&
          (channelsQuery.isLoading || catalogQuery.isLoading)
        }
        items={catalogQuery.data ?? []}
        onSelect={handleSelect}
      />
    </section>
  );
}
