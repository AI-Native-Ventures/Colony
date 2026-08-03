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

  const firstIndustry = page.getByTestId("discovery-industry-card-automotive");
  const lastIndustry = page.getByTestId(
    "discovery-industry-card-transportation",
  );
  await expect(firstIndustry).toBeVisible();
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
