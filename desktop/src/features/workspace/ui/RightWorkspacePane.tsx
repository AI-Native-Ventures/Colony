import type * as React from "react";

import { cn } from "@/shared/lib/cn";

type RightWorkspacePaneProps = {
  canResetWidth: boolean;
  children: React.ReactNode;
  expanded: boolean;
  onResetWidth: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  widthPx: number;
};

export function RightWorkspacePane({
  canResetWidth,
  children,
  expanded,
  onResetWidth,
  onResizeStart,
  widthPx,
}: RightWorkspacePaneProps): React.JSX.Element {
  return (
    <aside
      aria-label="Channel workspace"
      className={cn(
        "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-background before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-50 before:w-px before:bg-border/80 before:content-['']",
        expanded && "absolute inset-0 z-[70] w-full",
      )}
      data-testid="channel-workspace-pane"
      style={expanded ? undefined : { width: widthPx }}
    >
      {expanded ? null : (
        <button
          aria-label="Resize workspace"
          className="group/workspace-resize absolute inset-y-0 left-0 z-50 w-3 -translate-x-1/2 cursor-col-resize"
          data-testid="workspace-pane-resize-handle"
          onDoubleClick={canResetWidth ? onResetWidth : undefined}
          onPointerDown={onResizeStart}
          title={
            canResetWidth
              ? "Drag to resize. Double-click to reset width."
              : "Drag to resize."
          }
          type="button"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover/workspace-resize:bg-border/80 group-focus-visible/workspace-resize:bg-border/80" />
        </button>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
    </aside>
  );
}
