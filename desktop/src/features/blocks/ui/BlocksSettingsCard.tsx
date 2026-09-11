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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import { RichPreviewGallery } from "./RichPreviewGallery";

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
        description="Rich previews and reusable views for your channels and threads."
        title="Blocks"
      />

      <Tabs defaultValue="workspace">
        <TabsList aria-label="Block libraries" className="mb-5">
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="examples">Examples</TabsTrigger>
        </TabsList>
        <TabsContent value="workspace">
          <h2 className="mb-2 text-base font-medium">Workspace Blocks</h2>
          <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
            Browse the Blocks available here. Pick one to preview, then continue
            in a conversation.
          </p>
          <BlocksCatalogList
            error={
              catalogQuery.error instanceof Error ? catalogQuery.error : null
            }
            isLoading={
              activeCommunity !== null &&
              (channelsQuery.isLoading || catalogQuery.isLoading)
            }
            items={catalogQuery.data ?? []}
            onSelect={handleSelect}
            key={activeCommunity?.id ?? "no-community"}
          />
        </TabsContent>
        <TabsContent value="examples">
          <RichPreviewGallery />
        </TabsContent>
      </Tabs>
    </section>
  );
}
