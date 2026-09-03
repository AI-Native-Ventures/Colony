import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { seedActiveIdentity } from "../helpers/onboarding";

// A blank username means the mock bridge reports no kind:0 profile event,
// which is what a brand-new founder looks like.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

test("a returning member signs in with email and password from a new laptop", async ({
  page,
}, testInfo) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  // The landing offers two doors; sign-in opens the account detour.
  await page
    .getByRole("button", { name: "Sign in to an existing account" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.getByText("colony-recovery-code.txt")).toHaveCount(0);

  // The recovery fallback names its file, then folds away again.
  await page.getByTestId("signin-use-recovery-code").click();
  await expect(page.getByText("colony-recovery-code.txt")).toBeVisible();
  await page.getByTestId("signin-use-password").click();

  await page.getByLabel("Email").fill("founder@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await waitForAnimations(page);
  await page.screenshot({
    path: testInfo.outputPath("account-signin-form.png"),
  });
  await page.getByRole("button", { name: "Sign in" }).click();

  // A signed-in imported identity is not a fresh founder: it lands past the
  // canvas signup straight at workspace setup, exactly like key import did.
  await expect(page.getByTestId("community-choice-create")).toBeVisible();
});

test("a taken email points at the sign-in door", async ({ page }, testInfo) => {
  // addInitScript must run before the bridge installs: React reads state on
  // mount and the bridge triggers it. The override keeps the canvas flow on
  // in this build, the same way the first-run spec does.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "colony.e2e.authFailure",
      JSON.stringify({ kind: "email-taken" }),
    );
  });
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Start with Colony" }).click();
  const nameInput = page.getByLabel("Your name");
  await expect(nameInput).toBeVisible();

  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Continue" }).click();

  const signInLink = page.getByTestId("onb-account-taken-sign-in");
  await expect(signInLink).toBeVisible();
  await expect(
    page.getByText("That email already has an account."),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: testInfo.outputPath("account-taken-sign-in.png"),
  });

  // The exit is real: it opens the account-signin detour.
  await signInLink.click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
});
