import { waitForAnimations } from "../helpers/animations";
import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  createFounderAccount,
  describeFounderBusiness,
} from "../helpers/onboarding";

/** Real entry routing and renderer with synthetic account/native fixtures. */
test("public first run: account and business forms reach the existing Welcome channel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedActiveIdentity(page, { ...TEST_IDENTITIES.tyler, username: "" });
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-account-1440.png",
  });
  await createFounderAccount(page);
  await expect(page.getByTestId("onboarding-recovery-code")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-recovery-1440.png",
  });
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Your business" }),
  ).toBeVisible();
  await describeFounderBusiness(page);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-business-1440.png",
  });
  await page.getByRole("button", { name: "Open my Colony" }).click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  await expect(page).toHaveURL(/channels/);
  await expect(
    page.getByRole("heading", { name: /Pick who|Put something/ }),
  ).toHaveCount(0);
});
