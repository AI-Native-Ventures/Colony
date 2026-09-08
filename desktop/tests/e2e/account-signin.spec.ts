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

  // Account entry is immediate; returning members use its sign-in action.
  const account = page.getByTestId("onboarding-account");
  await expect(account).toBeVisible();
  await account.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await expect(page.getByText("colony-recovery-code.txt")).toHaveCount(0);

  // The recovery fallback names its file, then folds away again.
  await page.getByTestId("signin-use-recovery-code").click();
  await expect(page.getByText("colony-recovery-code.txt")).toBeVisible();
  await expect(page.getByLabel("Recovery code", { exact: true })).toBeVisible();
  await page.getByTestId("signin-use-password").click();
  await expect(page.getByText("colony-recovery-code.txt")).toHaveCount(0);
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(
    0,
  );

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
  // The typed failure fixture belongs to the canvas auth service. Resume just
  // after native identity setup, with no account or recovery completion seeded.
  // Seed before bridge installation because React reads these flags on mount.
  await page.addInitScript((pubkey) => {
    window.localStorage.setItem(
      "colony.e2e.authFailure",
      JSON.stringify({ kind: "email-taken" }),
    );
    window.localStorage.setItem(`colony.identity.fresh:${pubkey}`, "true");
    window.localStorage.setItem(
      `buzz-machine-onboarding-complete.v2:${pubkey}`,
      "true",
    );
  }, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  const account = page.getByTestId("onboarding-account");
  await expect(account).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("correct horse battery");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  const signInLink = account.getByRole("button", {
    name: "Sign in",
    exact: true,
  });
  await expect(signInLink).toBeVisible();
  await expect(account.getByRole("alert")).toHaveText(
    "That email already has an account. Sign in to continue.",
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
    "aisha@rosebankauto.co.za",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    "correct horse battery",
  );
  await expect(page.getByTestId("onboarding-recovery")).toHaveCount(0);
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
