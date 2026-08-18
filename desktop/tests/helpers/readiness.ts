import { expect, type Page } from "@playwright/test";

/**
 * Readiness checks for E2E specs.
 *
 * Every flake fixed on 2026-08-18 had the same shape: the spec waited on
 * something that looked like readiness and was not. Visible is not closed,
 * visible is not scrollable, rendered is not "the test seam exists". Each of
 * those produced an error message that named the wrong thing, so the helpers
 * below exist to make the real precondition the easy one to write.
 *
 * Prefer these over hand-rolled waits. If you need a new one, put it here with
 * the evidence that made it necessary, the way these are documented.
 */

/**
 * Waits for one of the `window.__BUZZ_E2E_*` seams to be installed.
 *
 * The mock bridge installs its seams from a lazily loaded chunk, so they are
 * not guaranteed to exist when `page.goto` resolves: measured absent at the
 * first read in 3 of 5 local runs, landing 25ms to 55ms later.
 *
 * This matters more than it looks, because `expect.poll` does NOT retry a
 * callback that throws. It rethrows on the first call (verified with a call
 * counter: 5 of 5, one call each). So the natural-looking
 *
 *   await expect.poll(() => page.evaluate(() => {
 *     const seam = window.__BUZZ_E2E_GET_RELAY_CONNECTION_STATE__;
 *     if (!seam) throw new Error("seam is not installed");
 *     return seam();
 *   })).toBe("connected");
 *
 * is not a poll at all: a seam 30ms behind fails the test outright. CI reported
 * exactly that on run 32129293431, smoke shard 5, with no timeout message.
 *
 * Wait for the seam first, then poll its value.
 */
export async function waitForBridgeSeam(
  page: Page,
  seam: `__BUZZ_E2E_${string}__`,
  timeoutMs = 15_000,
) {
  await page.waitForFunction(
    (name) =>
      typeof (window as unknown as Record<string, unknown>)[name] ===
      "function",
    seam,
    { timeout: timeoutMs },
  );
}

/**
 * Waits until a conversation timeline can actually scroll.
 *
 * `useWebviewScrollBoundaryLock` only lets a wheel through when something in
 * the event path is a scroll container with somewhere to go, which it decides
 * with `scrollHeight > clientHeight + 1`. A timeline that is visible but whose
 * seeded messages have not laid out yet fails that test, so the lock treats the
 * gesture as dead space and calls preventDefault.
 *
 * Any spec that dispatches wheel events, asserts scroll position, or measures
 * timeline geometry wants this rather than `toBeVisible()`. Sampling at the
 * dispatch point caught `scrollHeight === clientHeight` in 1 of 12 local runs;
 * CI hit it on run 31955085804, smoke shard 4.
 */
export async function waitForScrollableTimeline(
  page: Page,
  testId = "message-timeline",
  timeoutMs = 15_000,
) {
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const timeline = document.querySelector(`[data-testid="${id}"]`);
          return timeline instanceof HTMLElement
            ? timeline.scrollHeight > timeline.clientHeight + 1
            : false;
        }, testId),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

/**
 * Waits for every open dialog to leave the DOM.
 *
 * `toBeVisible()` ignores occlusion, so asserting on something behind an open
 * dialog passes happily and proves nothing about the dialog. The next pointer
 * action then spends the whole 30s test budget retrying against the overlay,
 * and reports the element it was trying to reach rather than the one covering
 * it. CI run 31955085804, smoke shard 2, logged 53 such retries against
 * `<button aria-label="Close lightbox">` before timing out.
 *
 * Call this after any Escape, close click, or save that is expected to dismiss
 * a dialog, before touching what was underneath it.
 */
export async function expectDialogClosed(page: Page, timeoutMs = 15_000) {
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: timeoutMs });
}

/**
 * Waits for a deep link to be consumed.
 *
 * The app drops `messageId` from the URL once the deep-linked row is centered
 * (`useAnchoredScroll`'s onTargetReached, consumed in `ChannelRouteScreen`).
 * That rewrite is a same-document navigation, and Playwright rejects whatever
 * `page.evaluate` is in flight when it lands, reporting it as "Execution
 * context was destroyed, most likely because of a navigation". Nothing is
 * destroyed: a marker set on `window` survives it and a concurrent evaluate
 * resolves through it.
 *
 * `waitForAnimations` holds such an evaluate for up to a second, so a capture
 * taken before the deep link settles is a coin flip. The rewrite landed inside
 * that window in 6 of 15 local runs at BUZZ_E2E_CPU_THROTTLE=6, and killed a
 * test on CI run 32129293431, smoke shard 5.
 *
 * Waiting for it also means the frame you capture is the settled one rather
 * than a mid-scroll one.
 */
export async function settleDeepLink(page: Page, timeoutMs = 15_000) {
  await expect
    .poll(() => page.url().includes("messageId="), { timeout: timeoutMs })
    .toBe(false);
}
