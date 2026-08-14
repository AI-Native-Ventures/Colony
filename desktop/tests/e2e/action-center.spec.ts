import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("opens the native Action Center with URL-backed filters and selection", async ({
  page,
}) => {
  await page.goto("/#/action-center");

  await expect(page.getByTestId("action-center-screen")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Action Center" }),
  ).toBeVisible();
  await expect(page.getByTestId("open-action-center-view")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(
    page.getByTestId("action-center-filter-needs-action"),
  ).toBeVisible();
  await expect(page.getByTestId("action-center-filter-all")).toBeVisible();

  const firstItem = page
    .locator('[data-testid^="action-center-item-"]')
    .first();
  if (await firstItem.isVisible().catch(() => false)) {
    const itemId = (await firstItem.getAttribute("data-testid"))?.replace(
      "action-center-item-",
      "",
    );
    expect(itemId).toBeTruthy();
    await firstItem.click();
    await expect(page).toHaveURL(
      new RegExp(`[?&]item=${encodeURIComponent(itemId ?? "")}`),
    );
  }

  await page.getByTestId("action-center-filter-all").click();
  await expect(page).toHaveURL(/filter=all/);
  await expect(page.getByTestId("action-center-list-pane")).toBeVisible();
});
