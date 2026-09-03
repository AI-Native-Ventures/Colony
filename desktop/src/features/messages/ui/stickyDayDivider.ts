// desktop/src/features/messages/ui/stickyDayDivider.ts

/** What the sticky day label needs to know to decide whether it has a job. */
export type ActiveDayDividerInput = {
  /** The scroller's current offset. 0 is the very top of the timeline. */
  scrollOffset: number;
  /**
   * The last divider whose item offset is at or above the pinned line, as an
   * index into the timeline's day dividers. -1 when there is none.
   */
  candidateIndex: number;
  /**
   * Where that divider's own pill is drawn, relative to the scroller, or null
   * when the divider is not rendered (virtualised away above the window).
   */
  candidatePillTop: number | null;
  /** Where the pinned label sits, relative to the scroller. */
  pinnedTop: number;
};

/**
 * Which day divider the sticky label should be showing, or -1 for none.
 *
 * The label exists to keep the day visible once its divider has gone off the
 * top. At the very top of the timeline nothing has gone anywhere: every
 * divider on screen is readable where it belongs, so a pinned copy is pure
 * overlap. And the pinned line sits just below the channel header, which is
 * exactly where the first message row starts, so in the welcome channel the
 * copy landed on the first line of the first message.
 *
 * Below the top the label keeps its existing behaviour, including carrying the
 * current day while its own divider is still travelling up to the line: a
 * divider that has passed the line hands over to the one before it, and the
 * first divider has nothing to hand over to.
 */
export function activeDayDividerIndex({
  scrollOffset,
  candidateIndex,
  candidatePillTop,
  pinnedTop,
}: ActiveDayDividerInput): number {
  if (scrollOffset <= 0) return -1;
  if (
    candidateIndex > 0 &&
    candidatePillTop !== null &&
    candidatePillTop > pinnedTop
  ) {
    return candidateIndex - 1;
  }
  return candidateIndex;
}
