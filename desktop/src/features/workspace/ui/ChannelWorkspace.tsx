import * as React from "react";

import { setChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  clearActiveTab,
  getWorkspace,
  openTab,
  setActiveTab,
  useWorkspace,
} from "@/features/workspace/lib/workspaceTabs";
import { closeWorkspaceTab } from "@/features/workspace/lib/closeWorkspaceTab";
import { getStripDragHandler } from "@/features/factory/lib/factoryDragBridge";
import { getTabBody } from "@/features/workspace/kinds";
import { NewTabPage } from "@/features/workspace/ui/NewTabPage";
import { WorkspaceTabStrip } from "@/features/workspace/ui/WorkspaceTabStrip";
import { cn } from "@/shared/lib/cn";
import { channelChrome } from "@/shared/layout/chromeLayout";

type ChannelWorkspaceProps = {
  channelId: string;
};

/**
 * The channel workspace: one tab strip over one active tab body.
 *
 * The shell owns the strip, the lifecycle, and which tab is active. It never
 * reads a tab's payload and never branches on its kind beyond a registry
 * lookup, so a new kind is a registration rather than a change here.
 */
export function ChannelWorkspace({
  channelId,
}: ChannelWorkspaceProps): React.JSX.Element {
  const { tabs, activeTabId } = useWorkspace(channelId);

  const handleCreate = React.useCallback(
    (kind: string) => {
      const definition = getTabKind(kind);
      if (!definition) return;
      openTab(channelId, {
        kind: definition.kind,
        title: definition.createTitle(),
        createdBy: "local",
        payload: definition.createPayload(),
      });
    },
    [channelId],
  );

  const handleNewTab = React.useCallback(() => {
    // The new-tab page renders when nothing is active, so this only needs to
    // clear the active tab rather than create one of a guessed kind.
    clearActiveTab(channelId);
  }, [channelId]);

  const handleClose = React.useCallback(
    async (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      await closeWorkspaceTab(channelId, tabId);
      if (getWorkspace(channelId).tabs.length === 0) {
        setChannelSurfaceMode(channelId, "timeline");
      }
    },
    [channelId, tabs],
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const Body = activeTab ? getTabBody(activeTab.kind) : undefined;

  // Hide factory-owned workspace tabs from the strip when the factory
  // tab is active. They remain in the store and reappear when the factory
  // tab is closed.
  const activeFactoryDef = activeTab ? getTabKind(activeTab.kind) : undefined;
  const factoryOwnedTabIds =
    activeTab && activeFactoryDef?.ownedTabIds
      ? activeFactoryDef.ownedTabIds(activeTab)
      : [];
  const visibleTabs =
    factoryOwnedTabIds.length > 0
      ? tabs.filter((t) => !factoryOwnedTabIds.includes(t.id))
      : tabs;

  // A kind that owns tabs of its own can accept one dragged out of the strip.
  // The shell only forwards the pointer down; the mounted body decides what a
  // drag means, so nothing here knows which kind is active.
  const activeKindArrangesTabs = Boolean(activeFactoryDef?.ownedTabIds);
  const handleTabPointerDown = React.useCallback(
    (tabId: string, event: React.PointerEvent) => {
      getStripDragHandler()?.(tabId, event);
    },
    [],
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        channelChrome.contentPadding,
      )}
      data-testid="channel-workspace"
    >
      <WorkspaceTabStrip
        activeTabId={activeTabId}
        onBackToConversation={() =>
          setChannelSurfaceMode(channelId, "timeline")
        }
        onClose={handleClose}
        onNewTab={handleNewTab}
        onSelect={(tabId) => setActiveTab(channelId, tabId)}
        onTabPointerDown={
          activeKindArrangesTabs ? handleTabPointerDown : undefined
        }
        tabs={visibleTabs}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {activeTab && Body ? (
          <Body channelId={channelId} tab={activeTab} />
        ) : activeTab ? (
          <div
            className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
            data-testid="workspace-unknown-kind"
          >
            This tab needs a newer version of the app to open.
          </div>
        ) : (
          <NewTabPage channelId={channelId} onCreate={handleCreate} />
        )}
      </div>
    </div>
  );
}
