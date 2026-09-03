import { test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";

const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };
const OUT = "test-results/onboarding-tour";

async function shot(page: Page, name: string) {
  await waitForAnimations(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test("tour", async ({ page }) => {
  // The canvas flow runs before any community exists, so the tour has to
  // start where a founder does: no community seeded, and the machine landing
  // passed by hand.
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  await shot(page, "00-machine-landing");
  await page.getByRole("button", { name: "Start with Colony" }).click();

  await shot(page, "01-account");
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await shot(page, "02-account-filled");
  await page.getByRole("button", { name: "Continue" }).click();

  await shot(page, "03-recovery-code");
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await shot(page, "04-company");
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await shot(page, "05-company-filled");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await shot(page, "06-building");
  await page
    .getByRole("heading", { name: "Tell us what you do." })
    .waitFor({ timeout: 15_000 });
  await shot(page, "07-building-draft");
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await page
    .getByRole("heading", { name: "Pick who does the thinking." })
    .waitFor({ timeout: 15_000 });
  await shot(page, "08-brain");
  await page.getByRole("button", { name: "Continue" }).click();

  await shot(page, "09-credits");
});
