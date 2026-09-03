import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

// A blank username means the mock bridge reports no kind:0 profile event,
// which is what a brand-new founder looks like.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

/**
 * The journey a real public-build founder walks: fresh identity, canvas flow,
 * a workspace claimed by the flow itself, then the Welcome channel.
 *
 * This is the regression test for the failure that made the redesign
 * invisible: the public build routed first runs through the legacy community
 * flow, whose completion wrote the gate key that kept the canvas flow shut.
 * If this spec stops reaching "Let's get your colony started.", the redesign
 * has fallen out of the shipped path again.
 */
test("public first run: fresh identity to Welcome through the canvas flow", async ({
  page,
}) => {
  // Nothing about the founder is seeded: "Start with Colony" is what writes
  // the fresh-identity marker, so this walk proves the real chain rather than
  // a fixture standing in for it.
  await page.addInitScript(() => {
    window.localStorage.setItem("colony.e2e.newOnboarding", "1");
  });
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await page.getByRole("button", { name: "Start with Colony" }).click();

  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Your way back in." }),
  ).toBeVisible();
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // The company screen claims a hosted workspace for real. The address it
  // mints is never shown: the user typed a company name, not a hostname.
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("colony.ainative.ventures")).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible();
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();
  await page.getByTestId("onboarding-credits-later").click();

  // The flow hands control to the app only once the workspace is open.
  await expect(page.locator(".onb-canvas")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
});
