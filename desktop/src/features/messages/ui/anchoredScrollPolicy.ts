import type { TimelineMessageDelta } from "@/features/messages/lib/timelineSnapshot";

/**
 * Distance (in CSS pixels) below which we consider the scroll position
 * "at the bottom" of the message list. Tight enough that the user has to
 * actually scroll down to re-pin; permissive enough to tolerate sub-pixel
 * rounding from the layout engine.
 */
export const AT_BOTTOM_THRESHOLD_PX = 32;

export type AnchorState =
  | { kind: "at-bottom" }
  | { kind: "message"; messageId: string; topOffset: number }
  | { kind: "pinned-center"; messageId: string; contentTop: number };

export function isAtBottomNow(
  container: Pick<
    HTMLDivElement,
    "scrollHeight" | "clientHeight" | "scrollTop"
  >,
) {
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    AT_BOTTOM_THRESHOLD_PX
  );
}

/**
 * Pick an anchor for the current scroll position.
 *
 * Top-crossing walk: chronological children, top-down. The first
 * `data-message-id` row whose bottom edge has crossed below the container
 * top is the anchor — that's the row the reader's eye is on when they've
 * scrolled up through history. `topOffset` is the row's top relative to
 * the container's top and may be negative when the row straddles the edge.
 *
 * If no such row exists (e.g. nothing scrolled past the top, list shorter
 * than the viewport, etc.) the anchor is `at-bottom`.
 *
 * Algorithm credit: Sami's [13] in the buzz-bugs scroll-redesign thread,
 * supersedes the Matrix-style bottom-up walk in [7]. The top-crossing
 * choice is what keeps the row the reader is *reading* fixed under
 * in-viewport reflow (image-load, embed expansion).
 */
export function computeAnchor(
  container: HTMLDivElement,
  treatNearBottomAsBottom = true,
): AnchorState {
  if (treatNearBottomAsBottom && isAtBottomNow(container)) {
    return { kind: "at-bottom" };
  }

  const containerTop = container.getBoundingClientRect().top;
  const rows = container.querySelectorAll<HTMLElement>("[data-message-id]");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rect = row.getBoundingClientRect();
    if (rect.bottom > containerTop) {
      const messageId = row.dataset.messageId;
      if (messageId) {
        return {
          kind: "message",
          messageId,
          topOffset: rect.top - containerTop,
        };
      }
    }
  }

  return { kind: "at-bottom" };
}

export function getPinnedCenterDrift({
  contentTop,
  currentContentTop,
}: {
  contentTop: number;
  currentContentTop: number;
}): number | null {
  const drift = currentContentTop - contentTop;
  return Math.abs(drift) > 0.5 ? drift : null;
}

export function shouldIgnorePinnedCenterScroll({
  currentScrollTop,
  expectedScrollTop,
  isWritingScroll,
}: {
  currentScrollTop: number;
  expectedScrollTop: number | null;
  isWritingScroll: boolean;
}): boolean {
  return isWritingScroll || expectedScrollTop === currentScrollTop;
}

// Programmatic bottom pins require the physical floor, not merely the looser
// UI at-bottom threshold used for unread affordances.
const TRUE_BOTTOM_THRESHOLD_PX = 1;

type BottomSettleContainer = Pick<
  HTMLDivElement,
  "scrollHeight" | "clientHeight" | "scrollTop" | "scrollTo"
>;

export function settleProgrammaticBottomPin(
  container: BottomSettleContainer,
): boolean {
  container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  return (
    container.scrollHeight - container.clientHeight - container.scrollTop <=
    TRUE_BOTTOM_THRESHOLD_PX
  );
}

export function shouldReleaseProgrammaticBottomPin({
  currentScrollTop,
  expectedScrollTop,
}: {
  currentScrollTop: number;
  expectedScrollTop: number | null;
}): boolean {
  return expectedScrollTop !== null && currentScrollTop !== expectedScrollTop;
}

export function shouldSettleForSplitPanel({
  isAtBottom,
  splitPanelOpen,
}: {
  isAtBottom: boolean;
  splitPanelOpen: boolean;
}): boolean {
  return isAtBottom && splitPanelOpen;
}

export function shouldSettleVirtualizedBottom({
  isAtBottom,
  messageDelta,
  messagesArrived,
  messagesChanged,
}: {
  isAtBottom: boolean;
  messageDelta: TimelineMessageDelta;
  messagesArrived: number;
  messagesChanged: boolean;
}): boolean {
  return (
    isAtBottom &&
    messageDelta !== "prepend" &&
    (messagesArrived > 0 || messagesChanged)
  );
}
