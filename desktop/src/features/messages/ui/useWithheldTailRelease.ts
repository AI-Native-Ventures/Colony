import * as React from "react";

import { shouldReleaseWithheldTail } from "@/features/messages/lib/semanticBottomTransition";

/**
 * Releases a frozen timeline tail that is withholding output at a scroller
 * which is already at the bottom.
 *
 * `shouldReleaseWithheldTail` carries the reasoning for the condition. This
 * owns the wiring around it: which values it reads, when it re-checks, and
 * that it measures the live scroll element rather than a remembered offset.
 * The wiring is the part that broke in the field, so it is testable on its
 * own: the freeze latched, and nothing looked at it again.
 */
export function useWithheldTailRelease({
  onRelease,
  pendingCount,
  scrollElementRef,
  semanticAtBottom,
}: {
  onRelease: () => void;
  pendingCount: number;
  scrollElementRef: React.RefObject<HTMLElement | null>;
  semanticAtBottom: boolean;
}) {
  React.useEffect(() => {
    const scroller = scrollElementRef.current;
    const release = shouldReleaseWithheldTail({
      distanceFromBottom: scroller
        ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
        : null,
      pendingCount,
      semanticAtBottom,
    });
    if (release) onRelease();
  }, [onRelease, pendingCount, scrollElementRef, semanticAtBottom]);
}
