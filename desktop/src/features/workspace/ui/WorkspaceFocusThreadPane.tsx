import type * as React from "react";

import { FocusThreadDrawer } from "@/features/channels/ui/FocusThreadDrawer";

type WorkspaceFocusThreadPaneProps = {
  canResetWidth: boolean;
  channelName: string;
  children: React.ReactNode;
  focusOpen: boolean;
  focusWidthPx: number;
  normalWidthPx: number;
  onClose: () => void;
  ownsMessageThreadTestId: boolean;
  onResetWidth: () => void;
  onResizeStart: (event: React.PointerEvent<HTMLButtonElement>) => void;
  split: boolean;
  workspaceOpen: boolean;
};

export function WorkspaceFocusThreadPane({
  canResetWidth,
  channelName,
  children,
  focusOpen,
  focusWidthPx,
  normalWidthPx,
  onClose,
  ownsMessageThreadTestId,
  onResetWidth,
  onResizeStart,
  split,
  workspaceOpen,
}: WorkspaceFocusThreadPaneProps): React.JSX.Element {
  const mode = workspaceOpen
    ? "workspace"
    : focusOpen
      ? "focus"
      : split
        ? "split"
        : "standalone";
  return (
    <FocusThreadDrawer
      canResetWidth={canResetWidth}
      channelName={channelName}
      focusWidthPx={focusWidthPx}
      mode={mode}
      normalWidthPx={normalWidthPx}
      onClose={onClose}
      ownsMessageThreadTestId={ownsMessageThreadTestId}
      onResetWidth={onResetWidth}
      onResizeStart={onResizeStart}
    >
      {children}
    </FocusThreadDrawer>
  );
}
