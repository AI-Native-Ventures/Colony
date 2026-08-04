import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

test.use({ viewport: { width: 1280, height: 720 } });

test("all Discovery industries are reachable by scrolling", async ({
  page,
}) => {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("open-discovery-view").click();
  await expect(page).toHaveURL(/#\/discovery/);

  // Whichever card the taxonomy currently ends with, not a named one. The
  // test names an industry it will outlive otherwise: `transportation` was
  // last when this was written, and the taxonomy expansion to 34 industries
  // moved it into the middle, where scrolling to the bottom correctly leaves
  // it above the fold. That failure said nothing about scrolling.
  const industryCards = page.locator(
    '[data-testid^="discovery-industry-card-"]',
  );
  const firstIndustry = industryCards.first();
  const lastIndustry = industryCards.last();
  await expect(firstIndustry).toBeVisible();
  await expect(industryCards).not.toHaveCount(0);
  await expect(lastIndustry).toBeAttached();
  await expect(lastIndustry).not.toBeInViewport();

  const discoveryViewport = page
    .locator("[data-buzz-content-surface] > div")
    .first();
  const dimensions = await discoveryViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));

  expect(dimensions.overflowY).toBe("auto");
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  await discoveryViewport.hover();
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() => discoveryViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await discoveryViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(lastIndustry).toBeInViewport();
});
