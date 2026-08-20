import * as React from "react";

import { setChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  clearActiveTab,
  closeTab,
  getWorkspace,
  openTab,
  setActiveTab,
  useWorkspace,
} from "@/features/workspace/lib/workspaceTabs";
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
    (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const definition = getTabKind(tab.kind);
      void Promise.resolve(definition?.dispose?.(tab))
        .catch((error: unknown) => {
          console.error("Failed to dispose workspace tab:", error);
        })
        .finally(() => {
          closeTab(channelId, tabId);
          if (getWorkspace(channelId).tabs.length === 0) {
            setChannelSurfaceMode(channelId, "timeline");
          }
        });
    },
    [channelId, tabs],
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const Body = activeTab ? getTabBody(activeTab.kind) : undefined;

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
        isExpanded
        onClose={handleClose}
        onNewTab={handleNewTab}
        onSelect={(tabId) => setActiveTab(channelId, tabId)}
        onToggleExpanded={() => setChannelSurfaceMode(channelId, "timeline")}
        tabs={tabs}
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
          <NewTabPage onCreate={handleCreate} />
        )}
      </div>
    </div>
  );
}
