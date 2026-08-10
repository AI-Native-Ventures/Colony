import * as React from "react";

import {
  useChannelSurfaceMode,
  useWorkspaceExpanded,
} from "@/features/workspace/lib/channelSurfaceMode";
import { ChannelWorkspace } from "@/features/workspace/ui/ChannelWorkspace";
import { RightWorkspacePane } from "@/features/workspace/ui/RightWorkspacePane";
import { useWorkspacePanelWidth } from "@/features/workspace/ui/useWorkspacePanelWidth";

const WORKSPACE_WIDTH_CSS_PROPERTY = "--buzz-workspace-pane-width";

type ChannelWorkspaceDockProps = {
  channelId: string | null;
  hasAuxiliaryPane: boolean;
  layoutRef: React.RefObject<HTMLDivElement | null>;
};

export function ChannelWorkspaceDock({
  channelId,
  hasAuxiliaryPane,
  layoutRef,
}: ChannelWorkspaceDockProps): React.JSX.Element | null {
  const isOpen = useChannelSurfaceMode(channelId ?? undefined) === "workspace";
  const expanded = useWorkspaceExpanded(channelId ?? undefined);
  const { canReset, onResetWidth, onResizeStart, widthPx } =
    useWorkspacePanelWidth(layoutRef, hasAuxiliaryPane);

  React.useLayoutEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    if (isOpen && !expanded) {
      element.style.setProperty(WORKSPACE_WIDTH_CSS_PROPERTY, `${widthPx}px`);
    } else {
      element.style.removeProperty(WORKSPACE_WIDTH_CSS_PROPERTY);
    }
    return () => {
      element.style.removeProperty(WORKSPACE_WIDTH_CSS_PROPERTY);
    };
  }, [expanded, isOpen, layoutRef, widthPx]);

  if (!channelId || !isOpen) return null;

  return (
    <RightWorkspacePane
      canResetWidth={canReset}
      expanded={expanded}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
      widthPx={widthPx}
    >
      <ChannelWorkspace channelId={channelId} />
    </RightWorkspacePane>
  );
}
