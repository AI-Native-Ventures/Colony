import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

/**
 * Regression coverage for a real product bug: a genuinely new signup, on a
 * machine that already carries a DIFFERENT identity's community, fell
 * through the canvas flow entirely into the legacy OnboardingFlow
 * (ProfileStep -> AvatarStep -> key generation -> backup prompt), because
 * isFreshFounder's "does a community already exist" check was machine-wide
 * rather than scoped to the pubkey signing up. See freshFounder.ts.
 *
 * Scenario A is the control (already covered by onboarding-first-run-
 * public.spec.ts); Scenario B is the actual bug. Both capture a full ordered
 * screenshot sequence for visual review.
 */
// Directory name kept from this spec's original diagnostic run so the
// screenshots already attached to the fix PR keep resolving.
const DIR = "test-results/DEBUG-onboarding-sequence";

// Shared canvas walk used by both scenarios: after "Start with Colony", every
// screen must be the redesigned canvas flow, end to end, regardless of what
// else is already on the machine.
async function walkCanvasFlow(
  page: import("@playwright/test").Page,
  shot: (label: string) => Promise<void>,
  founderName: string,
  founderEmail: string,
  companyName: string,
) {
  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await shot("account");
  await page.getByLabel("Your name").fill(founderName);
  await page.getByLabel("Email").fill(founderEmail);
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Your way back in." }),
  ).toBeVisible();
  await shot("recovery-code");
  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await shot("company");
  await page.getByLabel("Company name").fill(companyName);
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 20_000 });
  await shot("assistant");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us about the work." }),
  ).toBeVisible();
  await shot("work-context");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible();
  await shot("summary");
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();
  await shot("tin");
  await page.getByTestId("onboarding-credits-later").click();

  await expect(page.locator(".onb-canvas")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  await shot("welcome");
}

// Scenario A: a genuinely fresh identity, nothing pre-seeded, walking the
// real "Start with Colony" chain -- the scenario onboarding-first-run-
// public.spec.ts already proves passes.
test("scenario A: genuinely fresh machine, fresh identity", async ({
  page,
}) => {
  const identity = { ...TEST_IDENTITIES.tyler, username: "" };
  await page.addInitScript(() => {
    window.localStorage.setItem("colony.e2e.newOnboarding", "1");
  });
  await seedActiveIdentity(page, identity);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  let n = 0;
  const shot = async (label: string) => {
    n += 1;
    await waitForAnimations(page);
    await page.screenshot({
      path: `${DIR}/A-${String(n).padStart(2, "0")}-${label}.png`,
      fullPage: true,
    });
  };

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await shot("machine-gate");
  await page.getByRole("button", { name: "Start with Colony" }).click();

  await walkCanvasFlow(
    page,
    shot,
    "Aisha Bello",
    "aisha@rosebankauto.co.za",
    "Rosebank Auto Care",
  );
});

// Scenario B: the machine has ALREADY completed onboarding once (a community
// already exists, e.g. from a first identity or an earlier session), and a
// SECOND, genuinely new identity signs up on that same machine. This is the
// "new account" case that never appears in the existing specs, which all
// seed either a completely empty machine (skipCommunitySeed) or an already-
// vouched-for identity (skipOnboardingSeed off).
test("scenario B: a second fresh identity on a machine that already has a community", async ({
  page,
}) => {
  const newIdentity = { ...TEST_IDENTITIES.alice, username: "" };

  await page.addInitScript(() => {
    window.localStorage.setItem("colony.e2e.newOnboarding", "1");
  });
  // installMockBridge's default (no skipCommunitySeed) seeds a community
  // stamped with tyler's pubkey -- simulating a machine that already has a
  // workspace from a first account. Then override the active identity to a
  // SECOND, genuinely new pubkey: no machine-onboarding completion, no
  // fresh-identity marker, no relay profile -- but communities.length is
  // NOT zero, since that community already exists on this machine.
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await seedActiveIdentity(page, newIdentity);

  await page.goto("/");

  let n = 0;
  const shot = async (label: string) => {
    n += 1;
    await waitForAnimations(page);
    await page.screenshot({
      path: `${DIR}/B-${String(n).padStart(2, "0")}-${label}.png`,
      fullPage: true,
    });
  };

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await shot("machine-gate");
  await page.getByRole("button", { name: "Start with Colony" }).click();

  // FIXED: this used to fork to the legacy OnboardingFlow's ProfileStep
  // ("What should we call you?") because isFreshFounder's community check
  // was machine-wide (tyler's pre-existing community disqualified alice, a
  // completely different, unvouched pubkey). isFreshFounder now scopes that
  // check to the signing-up pubkey, so alice gets the exact same canvas walk
  // as Scenario A despite tyler's community already existing on this
  // machine.
  await walkCanvasFlow(
    page,
    shot,
    "Zanele Nkosi",
    "zanele@rosebankauto.co.za",
    "Nkosi Logistics",
  );
});
