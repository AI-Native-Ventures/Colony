import { expect, type Page, test } from "@playwright/test";

import { settleTimelineAtLatest } from "./blocks-test-helpers";

// The state CI run 33087235433 failed in, modelled at its own numbers: a
// timeline parked off the bottom with 4675px of content and a 400px viewport,
// so the floor is exactly the 4275px the run reported. While rows are queued
// the timeline holds its scroll position, and "Jump to latest" is the only
// control that admits them, which is why the order the helper does things in
// is the whole behaviour under test.
// The hold refuses the scroll outright rather than putting the position back
// afterwards. A scroll listener that restores the position races its reader,
// because scroll events dispatch after the scroll: a poll reading in the same
// frame sees a floor it was never going to keep, and the negative test below
// then passes or fails on timing. `overflow: hidden` does not hold it either,
// since that blocks the user and not the script (measured: scrollTo still
// moves such an element the full 4275px). Refusing the write is the only model
// that holds for every reader on every run.
const WITHHOLDING_TIMELINE = `
<div data-testid="message-timeline" style="height:400px;overflow:auto">
  <div id="content" style="height:4675px"></div>
</div>
<button data-testid="message-scroll-to-latest">Jump to latest</button>
<script>
  const timeline = document.querySelector('[data-testid="message-timeline"]');
  const pill = document.querySelector('[data-testid="message-scroll-to-latest"]');
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTop',
  );
  Object.defineProperty(timeline, 'scrollTop', {
    configurable: true,
    get: () => scrollTop.get.call(timeline),
    set: () => {},
  });
  timeline.scrollTo = () => {};
  pill.addEventListener('click', () => {
    delete timeline.scrollTop;
    delete timeline.scrollTo;
    pill.remove();
  });
</script>
`;

// The shape this helper had before: assert the floor first, and only then
// consider the pill. Kept verbatim so the proof below measures the real change.
async function settleFloorBeforePill(page: Page, timeoutMs: number) {
  const timeline = page.getByTestId("message-timeline");
  const jumpToLatest = page.getByTestId("message-scroll-to-latest");
  await timeline.evaluate((element) => {
    element.scrollTo({ behavior: "auto", top: element.scrollHeight });
  });
  await expect
    .poll(
      () =>
        timeline.evaluate((element) =>
          Math.abs(
            element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        ),
      { timeout: timeoutMs },
    )
    .toBeLessThanOrEqual(1);
  if (await jumpToLatest.isVisible()) {
    await jumpToLatest.click();
  }
}

async function floorGap(page: Page) {
  return page
    .getByTestId("message-timeline")
    .evaluate((element) =>
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
    );
}

test("asserting the floor before dismissing the pill can never reach it", async ({
  page,
}) => {
  await page.setContent(WITHHOLDING_TIMELINE);
  await expect(settleFloorBeforePill(page, 3_000)).rejects.toThrow();
  // Not a slow assertion. The poll never moved: the pill it needed to click
  // first was still there, and the timeline held its position against it.
  expect(await floorGap(page)).toBe(4_275);
  await expect(page.getByTestId("message-scroll-to-latest")).toBeVisible();
});

test("settleTimelineAtLatest dismisses the pill and then reaches the floor", async ({
  page,
}) => {
  await page.setContent(WITHHOLDING_TIMELINE);
  await settleTimelineAtLatest(page);
  expect(await floorGap(page)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("message-scroll-to-latest")).toHaveCount(0);
});
