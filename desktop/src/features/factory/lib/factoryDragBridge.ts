/**
 * The one seam between the workspace tab strip and whatever multi-pane body
 * is currently mounted.
 *
 * The strip does not know that panes exist and the workspace shell does not
 * branch on a kind: a body that can accept a dragged tab registers a handler
 * here on mount and clears it on unmount, and the strip forwards pointer
 * downs to whatever is registered.
 */
import type * as React from "react";

export type StripDragHandler = (
  tabId: string,
  event: React.PointerEvent,
) => void;

let stripDragHandler: StripDragHandler | null = null;

export function setStripDragHandler(handler: StripDragHandler): void {
  stripDragHandler = handler;
}

/**
 * Clear the handler. Passing the handler that was registered makes this safe
 * against a remount whose effects run in the order mount-then-unmount: a
 * stale cleanup cannot drop a newer body's handler.
 */
export function clearStripDragHandler(handler?: StripDragHandler): void {
  if (handler === undefined || stripDragHandler === handler) {
    stripDragHandler = null;
  }
}

export function getStripDragHandler(): StripDragHandler | null {
  return stripDragHandler;
}
