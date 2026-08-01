import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

// Brand smoke: the Colony ant mark renders and the bee is gone. The default
// mocked home view has no persistent brand mark on screen (that lives on the
// boot splash and onboarding surfaces, both out of reach of this mock seed),
// so this exercises the Agents settings panel, where the "Colony Agent"
// runtime row renders AntMark via RuntimeIcon.
test("Agents settings render the Colony ant and no bee remains", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();

  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-agents").click();

  // The Colony Agent runtime row renders the ant mark.
  await expect(page.getByTestId("settings-harnesses")).toBeVisible();
  await expect(page.locator(".colony-mark").first()).toBeVisible();

  // No bee classes anywhere in the DOM.
  expect(await page.locator(".bee-sprite, .buzz-mark").count()).toBe(0);
});
