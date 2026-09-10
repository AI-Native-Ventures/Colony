import type * as React from "react";
import { X, SplitSquareVertical, SplitSquareHorizontal } from "lucide-react";
import { getTabBody } from "@/features/workspace/kinds";
import { cn } from "@/shared/lib/cn";
import type { TilePane } from "@/features/factory/lib/tileTree";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

export type FactoryPaneProps = {
  pane: TilePane;
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

export function FactoryPane({
  pane,
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

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background shadow-sm",
        isFocused ? "ring-1 ring-primary/40" : "border-border",
      )}
      data-testid={`factory-pane-${pane.id}`}
      onClick={() => onFocus()}
    >
      {/* Tab strip */}
      <div
        className="flex shrink-0 items-center gap-1 overflow-hidden rounded-t-md border-b border-border bg-muted/30 px-2 py-1"
        data-testid={`factory-pane-tabs-${pane.id}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {pane.tabIds.map((tabId) => {
            const tab = workspaceTabs.find((t) => t.id === tabId);
            const isActive = tabId === activeTabId;
            return (
              <button
                key={tabId}
                className={cn(
                  "group relative flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                  isActive
                    ? "bg-background border border-border text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onSetActiveTab(tabId);
                }}
                title={tab?.title ?? tabId}
                type="button"
                data-testid={`factory-tab-${tabId}`}
              >
                <span className="max-w-[8rem] truncate">
                  {tab?.title ?? tabId}
                </span>
                <span
                  className={cn(
                    "inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-[9px] font-medium opacity-0 transition-opacity hover:opacity-100",
                    isActive ? "opacity-100" : "",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tabId);
                  }}
                  aria-label={`Close ${tab?.title ?? tabId}`}
                  title="Close tab"
                >
                  <X className="h-2.5 w-2.5" />
                </span>
              </button>
            );
          })}
          {pane.tabIds.length === 0 && (
            <span className="text-xs text-muted-foreground">Empty pane</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSplitRight();
            }}
            title="Split right"
            type="button"
            aria-label="Split right"
          >
            <SplitSquareVertical className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onSplitDown();
            }}
            title="Split down"
            type="button"
            aria-label="Split down"
          >
            <SplitSquareHorizontal className="h-3 w-3" />
          </button>
          <button
            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-muted-foreground hover:bg-background/60 hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onClosePane();
            }}
            title="Close pane"
            type="button"
            aria-label="Close pane"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Pane body */}
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
