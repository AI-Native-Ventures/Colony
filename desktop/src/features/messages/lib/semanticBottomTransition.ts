/**
 * The timeline freezes its logical tail once the reader leaves the bottom, so
 * live arrivals queue behind the "jump to latest" pill instead of shifting
 * rows under the reading position. This resolves the state machine behind that
 * freeze.
 *
 * Two reports feed it, and they are not interchangeable:
 *
 * - `"scroll"` is the virtualizer's own scroll callback, which is the reader
 *   moving (or a programmatic scroll settling).
 * - `"resize"` is a re-measure taken because the scroller's box changed -
 *   opening or closing the thread panel, the composer growing. Geometry moved;
 *   the reader did not.
 *
 * Treating a resize as a reader movement is what stranded messages. The
 * sequence, observed under a throttled CPU on 2026-08-18:
 *
 *   1. Reader is at the bottom, tail live.
 *   2. The thread panel closes. Mid-resize, a scroll report computes a
 *      non-bottom distance from a half-applied box, so the tail freezes and
 *      `suppressNext` is armed.
 *   3. Freezing shortens the model, so the very next report says "at bottom".
 *      `suppressNext` swallows it, correctly, since that transition is an
 *      artifact of the freeze itself, not the reader returning.
 *   4. Nothing else moves. No further scroll event is coming.
 *
 * The tail stays frozen while the scroller sits at the bottom, so the pill
 * that would release it never renders (it renders on *not* at bottom) and the
 * held messages are unreachable. A send lands, the toast confirms it, and the
 * message is nowhere.
 *
 * So a resize report never freezes, and a resize report that lands at the
 * bottom releases even when `suppressNext` is armed: it is a fresh reading of
 * the box, not the echo of a freeze.
 */
export type TimelineAtBottomReason = "scroll" | "resize";

export type SemanticBottomState = {
  /** The virtualizer has reported a real bottom at least once this channel. */
  hasConfirmedBottom: boolean;
  /** Swallow the next at-bottom report; it is the freeze's own echo. */
  suppressNext: boolean;
  /** The tail is live (true) or frozen (false). */
  semanticAtBottom: boolean;
};

export type SemanticBottomTransition = {
  next: SemanticBottomState;
  /** The value to commit, or null to leave the committed state alone. */
  commit: boolean | null;
  /** Whether the virtualizer's pending bottom intent should be cancelled. */
  cancelBottomIntent: boolean;
};

export function resolveSemanticBottomTransition(
  state: SemanticBottomState,
  report: { atBottom: boolean; reason: TimelineAtBottomReason },
): SemanticBottomTransition {
  if (report.atBottom) {
    const next = { ...state, hasConfirmedBottom: true };
    if (state.suppressNext && report.reason === "scroll") {
      return {
        next: { ...next, suppressNext: false },
        commit: null,
        cancelBottomIntent: false,
      };
    }
    if (state.semanticAtBottom) {
      return {
        next: { ...next, suppressNext: false },
        commit: null,
        cancelBottomIntent: false,
      };
    }
    return {
      next: { ...next, suppressNext: false, semanticAtBottom: true },
      commit: true,
      cancelBottomIntent: false,
    };
  }

  // Geometry changed under a stationary reader. Never freeze on that.
  if (report.reason === "resize") {
    return { next: state, commit: null, cancelBottomIntent: false };
  }

  if (!state.hasConfirmedBottom) {
    return { next: state, commit: null, cancelBottomIntent: false };
  }
  if (!state.semanticAtBottom) {
    return { next: state, commit: null, cancelBottomIntent: true };
  }
  return {
    next: { ...state, suppressNext: true, semanticAtBottom: false },
    commit: false,
    cancelBottomIntent: true,
  };
}
