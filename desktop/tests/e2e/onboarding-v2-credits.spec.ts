import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

/**
 * The journey a founder who already has an account walks when they create
 * another community, and what the credit balance does around it.
 *
 * This file used to drive `OnboardingV2Flow`, three pastel screens that only
 * this journey could reach. It is the canvas walk now, so the two tests that
 * asserted V2's own runtime-check screen ("codex is connected", its Install
 * button) are gone with it: that screen never existed on the canvas, the
 * decision it displayed runs headlessly in `ensureAutomaticAgentConfig`, and
 * the decision itself is covered by automaticAgentSetup.test.mjs and
 * automaticRuntime.test.mjs.
 */

const TRANSACTION_STORAGE_KEY = "buzz-community-onboarding-transaction.v1";
const RELAY_URL = "wss://default.example.com";
const ZERO_BALANCE = {
  balance_nanousd: "0",
  currency: "USD" as const,
  status: "depleted" as const,
};

/**
 * A community that has just been created by a signed-in founder: it exists,
 * its relay is applied, and the transaction is parked on the stage that opens
 * the walk.
 */
async function seedCreatedCommunity(page: Page, transactionId: string) {
  const identity = { ...TEST_IDENTITIES.tyler, username: "" };
  await seedActiveIdentity(page, identity);
  await page.addInitScript(
    ({ pubkey, storageKey, id }) => {
      window.localStorage.setItem(
        `buzz-machine-onboarding-complete.v2:${pubkey}`,
        "true",
      );
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          addedCommunity: true,
          communityId: "e2e-created-community",
          communityName: "Second Company",
          createdAt: timestamp,
          id,
          relayUrl: "wss://default.example.com",
          // The returning-founder journey: the door in Settings that creates a
          // community, not a first run and not a join.
          source: "create-community",
          stage: "profile",
          updatedAt: timestamp,
        }),
      );
    },
    {
      pubkey: identity.pubkey,
      storageKey: TRANSACTION_STORAGE_KEY,
      id: transactionId,
    },
  );
}

/** Company, then the building screen, then the draft it ends on. */
async function walkToBrain(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible();
  await page.getByLabel("Company name").fill("Second Company");
  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Tell us what you do." }),
  ).toBeVisible({ timeout: 20_000 });
  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("A second company with its own operating context.");
  await page.getByRole("button", { name: "Looks right" }).click();
}

test("a created community walks the canvas, with a way out on every screen", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-canvas");
  await installMockBridge(
    page,
    {
      globalAgentConfig: {
        credential_mode: "byok",
        env_vars: {},
        model: null,
        preferred_runtime: "codex",
        provider: null,
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );

  await page.goto("/");

  // The canvas, not the pastel flow: the same first screen every founder
  // sees, minus the two that make an account. The counter proves those two
  // are not being counted against this walk.
  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("onboarding-step-counter")).toHaveText(
    "01 / 04",
  );

  // The way out is the requirement this journey exists to fix: it was reachable
  // only after an error, and the transaction survived a relaunch, so a founder
  // who did not want to finish had nowhere to go.
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();

  await walkToBrain(page);

  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();
  await page.getByTestId("onboarding-credits-later").click();

  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("the way out drops the founder into the community that was just created", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-exit");
  await installMockBridge(page, undefined, {
    relayWsUrl: RELAY_URL,
    skipOnboardingSeed: true,
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Now, your company." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("community-onboarding-exit").click();

  // The walk is over and cannot come back: the transaction is gone, so a
  // relaunch lands in the workspace rather than back on screen one.
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible({
    timeout: 15_000,
  });
  expect(
    await page.evaluate(
      (storageKey) => window.localStorage.getItem(storageKey),
      TRANSACTION_STORAGE_KEY,
    ),
  ).toBeNull();
});

test("a zero balance never stands between a second company and its workspace", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-zero-credits");
  await installMockBridge(
    page,
    {
      colonyCreditsAccount: ZERO_BALANCE,
      globalAgentConfig: {
        credential_mode: "colony_credits",
        env_vars: {},
        model: "deepseek-v4-flash",
        preferred_runtime: "buzz-agent",
        provider: "deepseek",
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );

  await page.goto("/");

  await walkToBrain(page);
  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // Nothing on the credits screen is a wall: an empty account still reaches
  // the workspace, and the balance says so beside the profile afterwards.
  await expect(
    page.getByRole("heading", { name: "Put something in the tin." }),
  ).toBeVisible();
  await page.getByTestId("onboarding-credits-later").click();

  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("sidebar-credits-balance")).toContainText(
    "Credits $0.00",
  );
});

test("a Colony Credits user sees the live balance beside the profile", async ({
  page,
}) => {
  await installMockBridge(page, {
    colonyCreditsAccount: ZERO_BALANCE,
    globalAgentConfig: {
      credential_mode: "colony_credits",
      env_vars: {},
      model: "deepseek-v4-flash",
      preferred_runtime: "buzz-agent",
      provider: "deepseek",
    },
  });

  await page.goto("/");

  const balance = page.getByTestId("sidebar-credits-balance");
  await expect(balance).toBeVisible();
  await expect(balance).toContainText("Credits $0.00");
  await balance.click();
  await expect(page.getByTestId("settings-agents")).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?section=agents$/);
});

test("bring-your-own-key users do not see a Colony Credits balance", async ({
  page,
}) => {
  await installMockBridge(page, {
    colonyCreditsAccount: ZERO_BALANCE,
    globalAgentConfig: {
      credential_mode: "byok",
      env_vars: {},
      model: null,
      provider: null,
    },
  });

  await page.goto("/");

  await expect(page.getByTestId("sidebar-credits-balance")).toHaveCount(0);
});
