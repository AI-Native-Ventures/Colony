import * as React from "react";

import type { Channel } from "@/shared/api/types";

/**
 * Whether the main column accepts a dropped file right now, and the setter the
 * composer reports its acceptance through.
 *
 * Split out of `ChannelPane` for the desktop size ratchet. The conditions stay
 * in one place: the overlay must exist, the composer must be usable, and the
 * composer itself must be accepting attachments - a voice note in progress
 * withdraws that acceptance (#6978).
 */
export function useMainColumnDropGate({
  hasMainComposerOverlay,
  isComposerDisabled,
  isSinglePanelView,
}: {
  hasMainComposerOverlay: boolean;
  isComposerDisabled: boolean;
  isSinglePanelView: boolean;
}) {
  const [acceptsMainAttachments, setAcceptsMainAttachments] =
    React.useState(true);
  const [isMainDeferredEditPending, setMainDeferredEditPending] =
    React.useState(false);
  return {
    canDropInMainColumn:
      hasMainComposerOverlay &&
      !isComposerDisabled &&
      !isMainDeferredEditPending &&
      acceptsMainAttachments &&
      !isSinglePanelView,
    isMainDeferredEditPending,
    setAcceptsMainAttachments,
    setMainDeferredEditPending,
  };
}

/**
 * Whether the pane is showing an open channel the viewer has not joined, the
 * one state that replaces the composer with a join prompt.
 *
 * Split out of `ChannelPane` for the desktop size ratchet; the predicate is
 * unchanged.
 */
export function isNonMemberChannelView(activeChannel: Channel | null) {
  return (
    activeChannel !== null &&
    !activeChannel.isMember &&
    activeChannel.visibility === "open" &&
    !activeChannel.archivedAt
  );
}
