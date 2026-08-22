import type * as React from "react";

import { useChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { ChannelWorkspace } from "@/features/workspace/ui/ChannelWorkspace";
import { RightWorkspacePane } from "@/features/workspace/ui/RightWorkspacePane";

type ChannelWorkspaceDockProps = {
  canResetWidth: boolean;
  channelId: string | null;
  hasThread: boolean;
  onResetWidth: () => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLHRElement>) => void;
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  threadWidthPx: number;
  workspaceWidthPx: number;
};

export function ChannelWorkspaceDock({
  canResetWidth,
  channelId,
  hasThread,
  onResetWidth,
  onResizeKeyDown,
  onResizeStart,
  threadWidthPx,
  workspaceWidthPx,
}: ChannelWorkspaceDockProps): React.JSX.Element | null {
  const isOpen = useChannelSurfaceMode(channelId ?? undefined) === "workspace";

  if (!channelId || !isOpen) return null;

  return (
    <RightWorkspacePane
      canResetWidth={canResetWidth}
      hasThread={hasThread}
      onResetWidth={onResetWidth}
      onResizeKeyDown={onResizeKeyDown}
      onResizeStart={onResizeStart}
      threadWidthPx={threadWidthPx}
      widthPx={workspaceWidthPx}
    >
      <ChannelWorkspace channelId={channelId} />
    </RightWorkspacePane>
  );
}
