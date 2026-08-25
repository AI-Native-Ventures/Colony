import type * as React from "react";

type RightWorkspacePaneProps = {
  canResetWidth: boolean;
  children: React.ReactNode;
  hasThread: boolean;
  onResetWidth: () => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLHRElement>) => void;
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  threadWidthPx: number;
  widthPx: number;
};

export function RightWorkspacePane({
  canResetWidth,
  children,
  hasThread,
  onResetWidth,
  onResizeKeyDown,
  onResizeStart,
  threadWidthPx,
  widthPx,
}: RightWorkspacePaneProps): React.JSX.Element {
  const maximumThreadWidth = Math.max(0, threadWidthPx + widthPx - 320);
  return (
    <aside
      aria-label="Channel workspace"
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-background before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-40 before:w-px before:bg-border/80 before:content-['']"
      data-testid="channel-workspace-pane"
      style={{ width: hasThread ? widthPx : "100%" }}
    >
      {hasThread ? (
        <hr
          aria-label="Resize thread context. Use arrow keys to resize and Home to reset."
          aria-orientation="vertical"
          aria-valuemax={Math.round(maximumThreadWidth)}
          aria-valuemin={Math.min(280, Math.round(maximumThreadWidth))}
          aria-valuenow={Math.round(threadWidthPx)}
          className="group/workspace-resize absolute inset-y-0 left-0 z-50 m-0 h-auto w-3 -translate-x-1/2 cursor-col-resize border-0 bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:content-[''] hover:before:bg-border/80 focus-visible:before:bg-border/80"
          data-testid="workspace-pane-resize-handle"
          onDoubleClick={canResetWidth ? onResetWidth : undefined}
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          tabIndex={0}
        />
      ) : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
      </div>
    </aside>
  );
}
