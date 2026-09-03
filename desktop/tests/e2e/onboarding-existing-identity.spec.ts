import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

/**
 * A key that exists on this machine but has no relay profile: signing in with
 * an existing account, a reinstall, a second machine, or an imported nsec.
 * The relay has no name for them, so onboarding opens on the canvas profile
 * screen and asks for one.
 */
const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

test("an existing key with no profile lands on the canvas profile screen", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-gate")).toBeVisible();
  await expect(page.getByTestId("onboarding-page-profile")).toBeVisible();
  await expect(page.getByTestId("onboarding-profile-avatar")).toBeVisible();

  // No password, no recovery code and no second avatar screen: this identity
  // already has a key, so the only open question is the name.
  await expect(page.getByTestId("onboarding-page-avatar")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-next")).toBeDisabled();
});

test("saving a name finishes onboarding and enters the app", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await page.getByTestId("onboarding-display-name").fill("Morty QA");
  await expect(page.getByTestId("onboarding-next")).toBeEnabled();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByTestId("onboarding-gate")).toHaveCount(0);
});
