import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";

// A blank username means the mock bridge reports no kind:0 profile event for
// the active identity, which is what keeps the app-level onboarding gate open.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

// The redesigned flow ships dark. The override key is only honoured in the
// e2e build mode (see newOnboardingFlag.ts), so this opts just these tests
// in while every other first-run spec keeps the old flow. The script must be
// registered before installMockBridge: React reads the flag on mount and the
// bridge triggers that mount.
async function seedFreshFirstRun(
  page: Page,
  extraStorage: Record<string, string> = {},
) {
  await page.addInitScript((extra) => {
    for (const [key, value] of Object.entries(extra)) {
      window.localStorage.setItem(key, value);
    }
  }, extraStorage);
  // The flow mounts above the community boundary now, so the founder marker
  // and an empty community list are what open it, not the app-level gate.
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
}

/**
 * Machine onboarding stands in front of the flow on a machine with no
 * community: its completion is vouched by a matching community pubkey, and
 * these runs deliberately have none. One click is the whole step.
 */
async function passMachineLanding(page: Page) {
  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await page.getByRole("button", { name: "Start with Colony" }).click();
}

test("a non-technical user can get from the first screen to the end", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");
  await passMachineLanding(page);

  // Screen 1: account. The primary button is dead until every field answers.
  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  // Screen 2: recovery code. Continue stays locked until the box is ticked.
  await expect(
    page.getByRole("heading", { name: "Your way back in." }),
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
  await expect(page.getByText("Building your workspace.")).toBeVisible();

  // Screen 5: the brain picker opens on Colony Agent whatever the mock
  // catalog reports ready, so the walk continues on the colony track. The
  // skip path off the credits screen exists on every track, so this no
  // longer depends on what the catalog says is installed.
  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  // Colony Agent is what the founder is defaulted into, not whichever tool
  // detection happened to find first.
  await expect(page.getByTestId("onboarding-brain-buzz-agent")).toHaveAttribute(
    "data-selected",
    "true",
  );
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

  // Screen 9: credits. Every track offers a way past it, so no payment
  // handoff is needed to finish.
  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();

  // One pack, not the seven-tile ladder. Someone who has not started yet
  // cannot choose between seven amounts of a thing they have never spent.
  await expect(page.getByTestId("onboarding-credits-pack")).toHaveCount(1);

  // This walk answered "no website", so nothing was read and the screen must
  // not offer money back against a reading that never happened.
  await expect(page.getByText("reading your website")).toHaveCount(0);

  // The Pay button fell below the fold at 1280x720 while the pack grid was
  // there, and the canvas is fixed to the viewport and clips, so it could not
  // be scrolled to: a dead end rather than a layout nit.
  const pay = page.getByTestId("onboarding-credits-pay");
  await expect(pay).toBeVisible();
  const payBox = await pay.boundingBox();
  expect((payBox?.y ?? 0) + (payBox?.height ?? 0)).toBeLessThanOrEqual(660);

  await page.getByTestId("onboarding-credits-later").click();

  // The flow hands control back to the app: the canvas unmounts and the main
  // shell takes over. An invite screen must not appear in between, since
  // invites ship dark while the download button is off the marketing site.
  await expect(page.locator(".onb-canvas")).toHaveCount(0);
  await waitForAnimations(page);
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
});

test("a taken email address is explained inline and keeps the form intact", async ({
  page,
}) => {
  // Pin the signup failure the real service would produce for a duplicate
  // address (see the e2e-only override in NewOnboardingFlow), so screen 1's
  // failure states stay testable without pointing the flow at a live relay.
  await seedFreshFirstRun(page, {
    "colony.e2e.authFailure": JSON.stringify({ kind: "email-taken" }),
  });
  await page.goto("/");
  await passMachineLanding(page);

  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  // The error sits on the email field, not as a dead button or a silent
  // nothing. The flow stays here.
  const emailField = page
    .locator("label.onb-field")
    .filter({ has: page.locator("#onb-account-email") });
  await expect(
    emailField.getByText("That email already has an account."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();

  // A failed signup never clears what was typed.
  await expect(page.getByLabel("Your name")).toHaveValue("Aisha Bello");
  await expect(page.getByLabel("Email")).toHaveValue(
    "aisha@rosebankauto.co.za",
  );
  await expect(page.getByLabel("Password")).toHaveValue("colonyprototype");
});

test("a disabled primary action always says what is missing", async ({
  page,
}) => {
  await seedFreshFirstRun(page);
  await page.goto("/");
  await passMachineLanding(page);

  // The rule the redesign exists to honour: never a dead Continue with no
  // reason. A short password shows the exact count still missing.
  // 12 is PASSWORD_MIN, which tracks MIN_PASSPHRASE_LEN in key_backup.rs: the
  // identity backup runs before signup posts, so a shorter password fails
  // locally and reads as a network error.
  await page.getByLabel("Password").fill("short");
  await expect(page.getByText("7 more characters")).toBeVisible();
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
    page.getByRole("heading", { name: "Pick who does the thinking." }),
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
