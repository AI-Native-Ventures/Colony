/**
 * The timeline freezes its logical tail once the reader leaves the bottom, so
 * live arrivals queue behind the "jump to latest" pill instead of shifting
 * rows under the reading position. This resolves the state machine behind that
 * freeze.
 *
 * Three reports feed it, and they are not interchangeable:
 *
 * - `"scroll"` is the virtualizer's scroll callback for a movement the reader
 *   made: a wheel, touch, pointer, or key gesture preceded it.
 * - `"layout"` is that same callback with no reader gesture behind it. Row
 *   re-measurement, shift compensation, or a programmatic settle moved the
 *   offset. The box reading is real; the reader did not move.
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
 *
 * `"layout"` exists because a second stranding class survived that fix, found
 * on CI on 2026-08-18 (mentions.spec.ts grouped join rows, artifact shows a
 * "6 new messages" pill with the rows it counts never rendered):
 *
 *   1. Reader is at the bottom, tail live. A batch of arrivals appends.
 *   2. The append grows `scrollSize` before the settle-to-bottom lands, and a
 *      re-measure emits a scroll callback inside that window. It computes a
 *      non-bottom distance with no gesture anywhere.
 *   3. Reported as `"scroll"`, that froze the tail AND cancelled the pending
 *      settle that would have returned to the bottom. `suppressNext` then
 *      swallowed the freeze's own at-bottom echo, and a stationary reader
 *      produced no further events, so every later arrival buffered forever.
 *
 * A reader movement always carries a gesture (wheel, pointer, touch, key). A
 * callback without one is the list moving itself, so it never freezes, and at
 * the bottom it releases like a resize does.
 */
export type TimelineAtBottomReason = "scroll" | "layout" | "resize";

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

  // Geometry changed under a stationary reader (`"resize"`), or the offset
  // moved with no gesture behind it (`"layout"`). Never freeze on either, and
  // never cancel the pending settle: in the layout case that settle is exactly
  // what carries the view back to the bottom.
  if (report.reason !== "scroll") {
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
