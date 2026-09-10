import type * as React from "react";
import { X, SplitSquareVertical, SplitSquareHorizontal } from "lucide-react";
import { getTabBody } from "@/features/workspace/kinds";
import { cn } from "@/shared/lib/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/shared/ui/context-menu";
import {
  collectAgentTabPubkeys,
  parseAgentTabPayload,
} from "@/features/factory/lib/agentTabPayload";
import { useAgentsWithOpenAsks } from "@/features/factory/ui/useAgentTileAsks";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { DropZone } from "@/features/factory/lib/dropGeometry";
import type { TilePane } from "@/features/factory/lib/tileTree";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";
import type { TabDragController } from "./useTabDrag";

export type FactoryPaneProps = {
  pane: TilePane;
  /** Every pane in the tree, in traversal order, for the move-to-pane menu. */
  panes: ReadonlyArray<TilePane>;
  drag: TabDragController;
  workspaceTabs: WorkspaceTab[];
  channelId: string;
  isFocused: boolean;
  onFocus: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
  onCloseTab: (tabId: string) => void;
  onSetActiveTab: (tabId: string | null) => void;
};

const OVERLAY_ZONE_CLASS: Record<DropZone, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-0",
};

const OVERLAY_LABEL: Record<DropZone, string> = {
  left: "Split left",
  right: "Split right",
  top: "Split top",
  bottom: "Split bottom",
  center: "Add as tab",
};

export function FactoryPane({
  pane,
  panes,
  drag,
  workspaceTabs,
  channelId,
  isFocused,
  onFocus,
  onSplitRight,
  onSplitDown,
  onClosePane,
  onCloseTab,
  onSetActiveTab,
}: FactoryPaneProps): React.JSX.Element {
  const activeTabId = pane.activeTabId;
  const activeTab = workspaceTabs.find((t) => t.id === activeTabId) ?? null;
  const BodyComponent = activeTab ? getTabBody(activeTab.kind) : null;
  const dropZone = drag.target?.paneId === pane.id ? drag.target.zone : null;
  // Which of this pane's agent tabs are blocked on the owner. The read is the
  // shared open-asks query, so every pane and the toolbar answer from one
  // fetch rather than one per tab strip.
  const agentPubkeys = collectAgentTabPubkeys(workspaceTabs, pane.tabIds);
  const askingAgents = useAgentsWithOpenAsks(agentPubkeys);
  const tabHasOpenAsk = (tab: WorkspaceTab | undefined): boolean => {
    if (tab?.kind !== "agent") return false;
    const pubkey = parseAgentTabPayload(tab.payload)?.agentPubkey;
    return pubkey !== undefined && askingAgents.has(normalizePubkey(pubkey));
  };

  return (
    // Focus follows the pointer rather than a click so it lands before a tab
    // drag starts, and so the pane root stays a plain container: the tabs and
    // buttons inside it are the interactive elements.
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background shadow-sm",
        isFocused ? "ring-1 ring-primary/40" : "border-border",
      )}
      data-factory-pane-id={pane.id}
      data-testid="factory-pane"
      id={`factory-pane-${pane.id}`}
      onPointerDownCapture={onFocus}
    >
      <div
        className="flex shrink-0 items-center gap-1 overflow-hidden rounded-t-md border-b border-border bg-muted/30 px-2 py-1"
        data-testid={`factory-pane-tabs-${pane.id}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {pane.tabIds.map((tabId) => {
            const tab = workspaceTabs.find((t) => t.id === tabId);
            const title = tab?.title ?? tabId;
            const isActive = tabId === activeTabId;
            const hasOpenAsk = tabHasOpenAsk(tab);
            return (
              <ContextMenu key={tabId}>
                <ContextMenuTrigger asChild>
                  <div
                    className={cn(
                      "group relative flex shrink-0 select-none items-center rounded-md px-2 py-1 text-xs transition-colors",
                      isActive
                        ? "bg-background border border-border text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-background/60",
                    )}
                    data-ask={hasOpenAsk ? "true" : undefined}
                    data-testid={`factory-tab-${tabId}`}
                  >
                    {hasOpenAsk ? (
                      <span
                        aria-hidden
                        className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning ring-2 ring-warning/25"
                        data-testid={`factory-tab-ask-dot-${tabId}`}
                      />
                    ) : null}
                    <button
                      className={cn(
                        "max-w-[8rem] truncate text-left outline-none",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => {
                        if (drag.consumeDragSuppression()) return;
                        onSetActiveTab(tabId);
                      }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        drag.startTabDrag(tabId, title, event);
                      }}
                      title={title}
                      type="button"
                    >
                      {title}
                    </button>
                    <button
                      className={cn(
                        "inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-3xs font-medium opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100",
                        isActive ? "opacity-100" : "",
                      )}
                      onClick={() => onCloseTab(tabId)}
                      aria-label={`Close ${title}`}
                      title="Close tab"
                      type="button"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={panes.length < 2}>
                      Move to pane
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {panes.map((candidate, index) =>
                        candidate.id === pane.id ? null : (
                          <ContextMenuItem
                            key={candidate.id}
                            onSelect={() =>
                              drag.moveTabToPaneId(tabId, candidate.id)
                            }
                          >
                            {`Pane ${index + 1}`}
                          </ContextMenuItem>
                        ),
                      )}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuItem
                    onSelect={() =>
                      drag.splitPaneWithTab(tabId, pane.id, "right")
                    }
                  >
                    Split right
                  </ContextMenuItem>
                  <ContextMenuItem
                    onSelect={() =>
                      drag.splitPaneWithTab(tabId, pane.id, "bottom")
                    }
                  >
                    Split down
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {pane.tabIds.length === 0 && (
            <span className="text-xs text-muted-foreground">Empty pane</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={onSplitRight}
            title="Split right"
            type="button"
            aria-label="Split right"
          >
            <SplitSquareVertical className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={onSplitDown}
            title="Split down"
            type="button"
            aria-label="Split down"
          >
            <SplitSquareHorizontal className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={onClosePane}
            title="Close pane"
            type="button"
            aria-label="Close pane"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {dropZone !== null && (
        <div
          className={cn(
            "pointer-events-none absolute z-20 flex items-center justify-center border-2 border-dashed border-primary bg-primary/20",
            OVERLAY_ZONE_CLASS[dropZone],
          )}
          data-testid="factory-drop-overlay"
          data-zone={dropZone}
        >
          <span className="rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-lg">
            {OVERLAY_LABEL[dropZone]}
          </span>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeTab && BodyComponent ? (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <BodyComponent channelId={channelId} tab={activeTab} />
          </div>
        ) : (
          <div
            className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden text-sm text-muted-foreground"
            data-testid={`factory-pane-empty-${pane.id}`}
          >
            Drop a tab here
          </div>
        )}
      </div>
    </div>
  );
}
