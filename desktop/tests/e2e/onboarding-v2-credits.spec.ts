import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import {
  fillFounderBusiness,
  openFounderBusiness,
} from "../helpers/simpleFounder";

/** Additional-business completion and live balance remain independent. */

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

/** A signed-in founder supplies business context without account or billing forms. */
async function fillSecondBusiness(page: Page) {
  await fillFounderBusiness(
    page,
    "Second Company",
    "A second company with its own operating context.",
  );
  await expect(page.getByTestId("onboarding-account")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-recovery")).toHaveCount(0);
}

test("a created community needs one business form with a way out", async ({
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

  await expect(page.getByTestId("onboarding-business")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("onboarding-step-counter")).toHaveText(
    "Your business · 1 of 1",
  );
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();
  await fillSecondBusiness(page);
  await openFounderBusiness(page);
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0);
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
    page.getByRole("heading", { name: "Tell us about your business" }),
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

  await fillSecondBusiness(page);
  await openFounderBusiness(page);
  // Zero credits do not insert a payment step between context and Welcome.
  await expect(page.getByTestId("onboarding-credits-later")).toHaveCount(0);
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0);
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
