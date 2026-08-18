import * as React from "react";
import type { VListHandle } from "virtua";

import type { TimelineAtBottomReason } from "@/features/messages/lib/semanticBottomTransition";

/** Distance from the bottom, in px, still counted as being at the bottom. */
const AT_BOTTOM_SLACK_PX = 32;

/**
 * Keeps everything that depends on the scroller's box in step with it: the
 * offscreen buffer Virtua renders ahead, and the at-bottom reading the
 * timeline's tail-freeze decisions are made from.
 *
 * The at-bottom half is the reason this is a hook rather than an inline
 * effect. At-bottom used to be reported only from Virtua's scroll callback,
 * so a resize could move the geometry out from under the last reading with
 * nothing left to correct it: no further scroll event is coming. Opening and
 * closing the thread panel did exactly that, froze the timeline's tail, and
 * stranded live arrivals with no affordance to release them. See
 * `resolveSemanticBottomTransition` for the full sequence and for why a
 * resize report is not interchangeable with a scroll report.
 *
 * Reports are withheld until the list is settled and actually scrollable.
 * `ResizeObserver` also fires during first layout, when `scrollSize` still
 * equals `viewportSize` so every reading looks like "at bottom", and acting
 * on that would mark an unread channel read before it has rendered.
 */
export function useTimelineScrollerResize({
  hasInitialPositionedRef,
  hostRef,
  listRef,
  onAtBottomStateChange,
}: {
  hasInitialPositionedRef: React.RefObject<boolean>;
  hostRef: React.RefObject<HTMLDivElement | null>;
  listRef: React.RefObject<VListHandle | null>;
  onAtBottomStateChange?: (
    atBottom: boolean,
    reason: TimelineAtBottomReason,
  ) => void;
}) {
  const [offscreenBufferSize, setOffscreenBufferSize] = React.useState(() =>
    typeof window === "undefined" ? 1_000 : window.innerHeight,
  );

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const syncToBox = () => {
      // Measure three viewports ahead so WebKit momentum does not outrun
      // Virtua's first ResizeObserver pass.
      setOffscreenBufferSize(host.clientHeight * 3);
      const list = listRef.current;
      if (
        !hasInitialPositionedRef.current ||
        !list ||
        list.viewportSize <= 0 ||
        list.scrollSize <= list.viewportSize
      ) {
        return;
      }
      const distanceFromBottom =
        list.scrollSize - list.viewportSize - list.scrollOffset;
      onAtBottomStateChange?.(
        distanceFromBottom <= AT_BOTTOM_SLACK_PX,
        "resize",
      );
    };
    syncToBox();
    const resizeObserver = new ResizeObserver(syncToBox);
    resizeObserver.observe(host);
    return () => resizeObserver.disconnect();
  }, [hasInitialPositionedRef, hostRef, listRef, onAtBottomStateChange]);

  return offscreenBufferSize;
}
