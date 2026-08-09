import type * as React from "react";
import { Maximize2, Minimize2, Plus, X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

type WorkspaceTabStripProps = {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  isExpanded: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onToggleExpanded: () => void;
};

/**
 * The one tab strip. There is exactly one level of tabs in a workspace, so this
 * component is never nested inside a tab body.
 */
export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  isExpanded,
  onSelect,
  onClose,
  onNewTab,
  onToggleExpanded,
}: WorkspaceTabStripProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1"
      data-testid="workspace-tab-strip"
      role="tablist"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            className={cn(
              "group flex min-w-0 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs",
              tab.id === activeTabId
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60",
            )}
            data-testid={`workspace-tab-${tab.id}`}
            key={tab.id}
          >
            <button
              aria-selected={tab.id === activeTabId}
              className="max-w-[12rem] truncate outline-none"
              onClick={() => onSelect(tab.id)}
              role="tab"
              type="button"
            >
              {tab.title}
            </button>
            <button
              aria-label={`Close ${tab.title}`}
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onClose(tab.id)}
              type="button"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        ))}
        <button
          aria-label="New tab"
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background/60"
          data-testid="workspace-new-tab"
          onClick={onNewTab}
          type="button"
        >
          <Plus aria-hidden className="size-4" />
        </button>
      </div>
      <button
        aria-label={isExpanded ? "Collapse workspace" : "Expand workspace"}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-background/60"
        data-testid="workspace-expand-toggle"
        onClick={onToggleExpanded}
        type="button"
      >
        {isExpanded ? (
          <Minimize2 aria-hidden className="size-4" />
        ) : (
          <Maximize2 aria-hidden className="size-4" />
        )}
      </button>
    </div>
  );
}
