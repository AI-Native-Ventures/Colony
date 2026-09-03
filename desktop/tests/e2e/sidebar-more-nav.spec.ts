import { expect, type Page, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const MOCK_PUBKEY = "deadbeef".repeat(8);

// The five a fresh founder finds under "More", and the four that stay in the
// open list beside the channels.
const GROUPED = [
  "open-pulse-view",
  "open-projects-view",
  "open-content-view",
  "open-workflows-view",
  "open-discovery-view",
] as const;
const ALWAYS_OPEN = [
  "open-agents-view",
  "open-billing-view",
  "open-work-view",
] as const;

/**
 * A founder who signed up on this machine and has finished first run: the
 * marker machine onboarding writes, plus the completion key, so the app boots
 * into the workspace rather than back into the flow.
 */
function seedFounderAtWorkspace(page: Page, pubkey: string) {
  return page.addInitScript(
    ({ freshKey, completeKey }) => {
      window.localStorage.setItem(freshKey, "true");
      window.localStorage.setItem(completeKey, "true");
    },
    {
      freshKey: `colony.identity.fresh:${pubkey}`,
      completeKey: `buzz-onboarding-complete.v1:${pubkey}`,
    },
  );
}

test.describe("the sidebar a fresh founder lands on", () => {
  test("groups five destinations under More, and opens on click", async ({
    page,
  }) => {
    await seedFounderAtWorkspace(page, MOCK_PUBKEY);
    await installMockBridge(page);
    await page.goto("/");

    await expect(page.getByTestId("sidebar-primary-menu")).toBeVisible();
    for (const testId of ALWAYS_OPEN) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
    // Channels are still there: the group hides destinations, not the work.
    await expect(page.getByTestId("channel-general")).toBeVisible();

    const label = page.getByTestId("sidebar-more-nav-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-expanded", "false");
    for (const testId of GROUPED) {
      await expect(page.getByTestId(testId)).toHaveCount(0);
    }

    await label.click();
    await expect(label).toHaveAttribute("aria-expanded", "true");
    for (const testId of GROUPED) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
  });

  test("stays open on the next boot", async ({ page }) => {
    await seedFounderAtWorkspace(page, MOCK_PUBKEY);
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("sidebar-more-nav-label").click();
    await expect(page.getByTestId("open-discovery-view")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("sidebar-more-nav-label")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("open-discovery-view")).toBeVisible();
  });

  test("everyone else sees today's flat sidebar", async ({ page }) => {
    // No fresh marker: an imported identity, or anyone whose first run
    // happened somewhere else.
    await installMockBridge(page);
    await page.goto("/");

    await expect(page.getByTestId("sidebar-primary-menu")).toBeVisible();
    await expect(page.getByTestId("sidebar-more-nav")).toHaveCount(0);
    for (const testId of [...GROUPED, ...ALWAYS_OPEN]) {
      await expect(page.getByTestId(testId)).toBeVisible();
    }
  });
});
