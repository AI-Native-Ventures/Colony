import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import {
  createFounderAccount,
  fillFounderBusiness,
  openFounderBusiness,
  saveFounderRecovery,
} from "../helpers/simpleFounder";

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

// Both identities must take the same account/recovery/business journey.
async function walkCanvasFlow(
  page: import("@playwright/test").Page,
  shot: (label: string) => Promise<void>,
  founderEmail: string,
  companyName: string,
) {
  await expect(page.getByTestId("onboarding-account")).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toHaveCount(0);
  await shot("account");
  await createFounderAccount(page, founderEmail);
  await shot("recovery-code");
  await saveFounderRecovery(page);
  await fillFounderBusiness(
    page,
    companyName,
    "We service and repair cars for owners around Johannesburg.",
  );
  await shot("business");
  await openFounderBusiness(page);
  await shot("welcome");
}

// Scenario A: a genuinely fresh identity, nothing pre-seeded, walking the
// public account entry -- the scenario onboarding-first-run-
// public.spec.ts already proves passes.
test("scenario A: genuinely fresh machine, fresh identity", async ({
  page,
}) => {
  const identity = { ...TEST_IDENTITIES.tyler, username: "" };
  await page.addInitScript(() => {});
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

  await walkCanvasFlow(
    page,
    shot,
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

  // Explicitly keep Tyler's existing community while Alice becomes the
  // active identity. The normal bridge seeder stamps the active identity,
  // which would accidentally turn this regression case into the control.
  await seedActiveIdentity(page, newIdentity);
  await page.addInitScript((pubkey) => {
    const community = {
      id: "first-account-community",
      name: "First account business",
      relayUrl: "wss://default.example.com",
      pubkey,
      addedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(
      "buzz-communities",
      JSON.stringify([community]),
    );
    window.localStorage.setItem("buzz-active-community-id", community.id);
  }, TEST_IDENTITIES.tyler.pubkey);
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
      path: `${DIR}/B-${String(n).padStart(2, "0")}-${label}.png`,
      fullPage: true,
    });
  };

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  const savedOwners = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem("buzz-communities") ?? "[]").map(
      (item: { pubkey: string }) => item.pubkey,
    ),
  );
  expect(savedOwners).toContain(TEST_IDENTITIES.tyler.pubkey);
  expect(savedOwners).not.toContain(newIdentity.pubkey);

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
    "zanele@rosebankauto.co.za",
    "Nkosi Logistics",
  );
});
