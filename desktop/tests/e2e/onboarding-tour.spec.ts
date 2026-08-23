import { test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };
const OUT = "test-results/onboarding-tour";

async function shot(page: Page, name: string) {
  await waitForAnimations(page);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test("tour", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("colony.e2e.newOnboarding", "1");
  });
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

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
  await page.getByRole("button", { name: "Create workspace" }).click();

  await shot(page, "05-probing");
  await page
    .getByRole("heading", { name: "You are already set up." })
    .waitFor({ timeout: 15_000 });
  await shot(page, "06-brain");
  await page.getByRole("button", { name: "Continue" }).click();

  await shot(page, "07-business");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await shot(page, "08-description");
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await shot(page, "09-credits");
});
