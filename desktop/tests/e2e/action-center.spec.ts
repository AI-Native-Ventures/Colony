import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("opens the native Action Center with URL-backed filters and selection", async ({
  page,
}) => {
  await page.goto("/#/action-center?item=message%3Amock-feed-mention");

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

  const selectedItem = page.getByTestId(
    "action-center-item-message:mock-feed-mention",
  );
  await expect(selectedItem).toBeVisible();
  await expect(selectedItem).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .getByTestId("action-center-message-detail")
      .getByText("Please review the release checklist."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Mark done" }).click();
  await expect(page).not.toHaveURL(/item=/);

  await page.getByTestId("action-center-filter-all").click();
  await expect(page).toHaveURL(/filter=all/);
  await expect(page.getByTestId("action-center-list-pane")).toBeVisible();

  await page.goto("/#/action-center?item=message%3Amissing-source");
  await expect(
    page.getByTestId("action-center-detail-unavailable"),
  ).toBeVisible();
  await expect(page.getByText("message:missing-source")).toBeVisible();
});
