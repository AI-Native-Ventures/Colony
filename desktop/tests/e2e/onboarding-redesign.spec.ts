import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

// A blank username means the mock bridge reports no kind:0 profile event for
// the active identity, which is what keeps the app-level onboarding gate open.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

// The redesigned flow ships dark. The override key is only honoured in the
// e2e build mode (see newOnboardingFlag.ts), so this opts just these tests
// in while every other first-run spec keeps the old flow. The script must be
// registered before installMockBridge: React reads the flag on mount and the
// bridge triggers that mount.
async function seedFreshFirstRun(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("colony.e2e.newOnboarding", "1");
  });
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
}

test("a non-technical user can get from the first screen to the end", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");

  // Screen 1: account. The primary button is dead until every field answers.
  await expect(
    page.getByRole("heading", { name: "Welcome to the colony." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 2: recovery code. Continue stays locked until the box is ticked.
  await expect(
    page.getByRole("heading", { name: "Keep this code somewhere safe." }),
  ).toBeVisible();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 3: company.
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Screen 4: the probe resolves on its own, no interaction.
  await expect(page.getByText("Getting things ready.")).toBeVisible();

  // Screen 5: the default mock runtime catalog reports Oh My Pi ready with no
  // login needed, so resolveTrack lands on the byo track: the brain picker
  // appears here with Oh My Pi preselected, and credits later offers its skip
  // button instead of a payment handoff. If someone changes that catalog so
  // nothing is ready, this screen becomes the timed Colony install instead
  // and credits loses its skip path, which breaks the rest of this walk.
  await expect(
    page.getByRole("heading", { name: "You are already set up." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 6: business. Answering "no website" skips the paid reading step.
  await expect(
    page.getByRole("heading", { name: "Tell us about the work." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 8: description. No website means the flow must not claim a finding.
  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible();
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  // Screen 9: credits. The byo track offers the skip path, so no payment
  // handoff is needed to finish.
  await expect(
    page.getByRole("heading", { name: "Put your colony to work." }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "I will use my own agent for now" })
    .click();

  // The flow hands control back to the app: the canvas unmounts and the main
  // shell takes over. An invite screen must not appear in between, since
  // invites ship dark while the download button is off the marketing site.
  await expect(page.locator(".onb-canvas")).toHaveCount(0);
  await waitForAnimations(page);
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
});

test("a disabled primary action always says what is missing", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");

  // The rule the redesign exists to honour: never a dead Continue with no
  // reason. A short password shows the exact count still missing.
  await page.getByLabel("Password").fill("short");
  await expect(page.getByText("5 more characters")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  // The same rule on the business screen: unanswered questions are named.
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "You are already set up." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Tell us about the work." }),
  ).toBeVisible();
  await expect(
    page.getByText("Answer both questions to continue."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});
