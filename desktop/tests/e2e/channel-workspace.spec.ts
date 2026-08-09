import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

test.describe("channel workspace", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
  });

  test("toggling the workspace replaces the timeline", async ({ page }) => {
    const toggle = page.getByTestId("channel-workspace-toggle");
    await expect(toggle).toBeVisible();

    await expect(page.getByTestId("channel-workspace")).toHaveCount(0);
    await toggle.click();

    const workspace = page.getByTestId("channel-workspace");
    await expect(workspace).toBeVisible();
    await waitForAnimations(page);
    await workspace.screenshot({
      path: "test-results/workspace/01-empty-workspace.png",
    });

    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
  });

  test("creating a scratchpad tab opens a body and a strip entry", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const body = page.getByTestId("workspace-scratchpad-body");
    await expect(body).toBeVisible();
    await body.fill("workspace notes for #general");

    await expect(page.getByTestId("workspace-tab-strip")).toBeVisible();
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/02-scratchpad-tab.png",
    });
  });

  test("two tabs share one strip with no nesting", async ({ page }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const strips = page.getByTestId("workspace-tab-strip");
    await expect(strips).toHaveCount(1, "there is exactly one tab strip");
    await expect(page.getByRole("tab")).toHaveCount(2);

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/03-two-tabs.png",
    });
  });

  test("the workspace survives leaving and returning to the channel", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-scratchpad-body").fill("kept");

    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("channel-workspace")).toHaveCount(
      0,
      "workspace mode is per channel, so #random opens on its timeline",
    );

    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("workspace-scratchpad-body")).toHaveValue(
      "kept",
    );
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/04-restored.png",
    });
  });
});
