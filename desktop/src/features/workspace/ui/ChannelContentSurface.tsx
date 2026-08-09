import type * as React from "react";

import { useChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { ChannelWorkspace } from "@/features/workspace/ui/ChannelWorkspace";

type ChannelContentSurfaceProps = {
  channelId: string | undefined;
  children: React.ReactNode;
};

/**
 * The channel content column's occupant: the workspace when this channel is in
 * workspace mode, otherwise whatever the channel normally renders.
 *
 * The branch lives here rather than in ChannelPane so the pane stays under the
 * 1000-line ceiling, and so the timeline keeps every prop it already had.
 */
export function ChannelContentSurface({
  channelId,
  children,
}: ChannelContentSurfaceProps): React.JSX.Element {
  const surfaceMode = useChannelSurfaceMode(channelId);
  return surfaceMode === "workspace" && channelId ? (
    <ChannelWorkspace channelId={channelId} />
  ) : (
    <>{children}</>
  );
}
