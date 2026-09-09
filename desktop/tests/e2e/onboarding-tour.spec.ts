import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";
import {
  fillFounderBusiness,
  openFounderBusiness,
  saveFounderRecovery,
} from "../helpers/simpleFounder";

const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };
const OUT = "test-results/onboarding-tour";

async function shot(page: Page, name: string) {
  await waitForAnimations(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test("tour", async ({ page }) => {
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-account")).toBeVisible();
  await shot(page, "01-account");
  await page.getByLabel("Your name", { exact: true }).fill("Horizon Owner");
  await page
    .getByLabel("Email", { exact: true })
    .fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password", { exact: true }).fill("colonyprototype");
  await shot(page, "02-account-filled");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  await expect(page.getByTestId("onboarding-recovery-code")).not.toBeEmpty();
  await shot(page, "03-recovery-code");
  await saveFounderRecovery(page);

  await shot(page, "04-business");
  await fillFounderBusiness(
    page,
    "Rosebank Auto Care",
    "We service and repair cars for owners around Johannesburg.",
  );
  await shot(page, "05-business-filled");
  await openFounderBusiness(page);
  await shot(page, "06-welcome");
});
