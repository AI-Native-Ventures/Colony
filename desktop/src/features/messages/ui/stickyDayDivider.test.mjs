// desktop/src/features/messages/ui/stickyDayDivider.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { activeDayDividerIndex } from "./stickyDayDivider.ts";

const PINNED_TOP = 100;

test("nothing_is_pinned_while_the_timeline_is_at_the_top", () => {
  // The welcome channel's whole complaint: a second "Today" pill landing on
  // the first line of the first message, with the real divider on screen.
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 0,
      candidateIndex: 0,
      candidatePillTop: 40,
      pinnedTop: PINNED_TOP,
    }),
    -1,
  );
});

test("nothing_is_pinned_when_the_scroller_is_bounced_past_the_top", () => {
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: -20,
      candidateIndex: 1,
      candidatePillTop: 10,
      pinnedTop: PINNED_TOP,
    }),
    -1,
  );
});

test("a_divider_that_has_passed_the_pinned_line_is_the_one_shown", () => {
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 400,
      candidateIndex: 1,
      candidatePillTop: 40,
      pinnedTop: PINNED_TOP,
    }),
    1,
  );
});

test("a_divider_still_below_the_pinned_line_hands_over_to_the_one_before_it", () => {
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 400,
      candidateIndex: 2,
      candidatePillTop: 180,
      pinnedTop: PINNED_TOP,
    }),
    1,
  );
});

test("the_first_divider_stays_pinned_while_it_travels_up_to_the_line", () => {
  // Below the top the label carries the current day continuously, including
  // while the divider it names is still on its way up. There is no earlier day
  // to hand over to, so this one holds.
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 416,
      candidateIndex: 0,
      candidatePillTop: 180,
      pinnedTop: PINNED_TOP,
    }),
    0,
  );
});

test("an_unrendered_divider_counts_as_scrolled_past", () => {
  // Virtua drops rows above the window: absent means gone off the top, which
  // is precisely what the pinned label is for.
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 4000,
      candidateIndex: 3,
      candidatePillTop: null,
      pinnedTop: PINNED_TOP,
    }),
    3,
  );
});

test("no_candidate_pins_nothing", () => {
  assert.equal(
    activeDayDividerIndex({
      scrollOffset: 400,
      candidateIndex: -1,
      candidatePillTop: null,
      pinnedTop: PINNED_TOP,
    }),
    -1,
  );
});
