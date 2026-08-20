import { expect, test } from "@playwright/test";

import { openSidebarDestination } from "../helpers/sidebar";
import { installMockBridge } from "../helpers/bridge";

const FAILED_ID = "mock-recovery-failed";
const CANCELLED_ID = "mock-recovery-cancelled";

async function openRecoveryWorkflow(page: import("@playwright/test").Page) {
  await page.goto("/");
  await openSidebarDestination(page, "open-workflows-view");
  await expect(page).toHaveURL(/#\/workflows$/);
  await expect(page.getByTestId("workflows-view")).toContainText(
    "Recovery test workflow",
  );
  await page
    .getByTestId("workflow-card-mock-recovery-failed")
    .getByRole("button", { name: "View Recovery test workflow" })
    .click();
  await openRunHistory(page);
}

/**
 * Run history moved inside the editor with #6248: opening a card opens the
 * editor, and the panel lives in a popover behind the Run history button.
 */
async function openRunHistory(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Run history" }).click();
  await expect(page.getByTestId("workflow-history-dropdown")).toBeVisible();
  await expect(page.getByTestId("workflow-detail-panel")).toBeVisible();
}

test("offers Run again only for failed and cancelled runs", async ({
  page,
}) => {
  await installMockBridge(page, {
    workflowRunSeeds: [
      {
        workflowId: FAILED_ID,
        status: "failed",
        errorMessage: "Worker stopped",
      },
      {
        workflowId: CANCELLED_ID,
        status: "cancelled",
        errorMessage: "Cancelled by operator",
      },
    ],
  });
  await openRecoveryWorkflow(page);

  const panel = page.getByTestId("workflow-detail-panel");
  const failed = panel.getByTestId("workflow-run-mock-seeded-run-1");
  await failed.click();
  await expect(
    panel.getByTestId("workflow-run-again-mock-seeded-run-1"),
  ).toBeVisible();
  await panel.getByTestId("workflow-run-again-mock-seeded-run-1").click();
  await expect(panel.getByTestId("workflow-selected-run")).toContainText(
    "completed",
  );

  // Close the editor back to the library. Escape alone lands on the popover,
  // so the list is reached through its own route.
  await page.goto("/#/workflows");
  await expect(page.getByTestId("workflows-view")).toBeVisible();
  await page
    .getByTestId("workflow-card-mock-recovery-cancelled")
    .getByRole("button", { name: "View Recovery test workflow" })
    .click();
  await openRunHistory(page);
  const cancelled = panel.getByTestId("workflow-run-mock-seeded-run-2");
  await cancelled.click();
  await expect(
    panel.getByTestId("workflow-run-again-mock-seeded-run-2"),
  ).toBeVisible();
});
