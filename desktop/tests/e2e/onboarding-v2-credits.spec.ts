import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { expectRetainedBusinessContext } from "../helpers/companyProfile";
import {
  seedActiveIdentity,
  continueFounderBusiness,
} from "../helpers/onboarding";
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
  const identity = TEST_IDENTITIES.tyler;
  await seedActiveIdentity(page, identity);
  await page.addInitScript(
    ({ pubkey, storageKey, id }) => {
      const seededKey = `e2e-created-business-seeded:${id}`;
      if (window.localStorage.getItem(seededKey)) return;
      window.localStorage.setItem(seededKey, "true");
      // The account is already set up; only this business remains unfinished.
      window.localStorage.setItem(
        `buzz-onboarding-complete.v1:${pubkey}`,
        "true",
      );
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
          ownerPubkey: pubkey,
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

test("a created community connects its detected subscription and chooses a model", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-canvas");
  await installMockBridge(
    page,
    {
      // The transaction starts after provisioning. Mirror that relay's empty,
      // signed bootstrap profile rather than a relay with no identity/head.
      communityProfileHead: { tradingName: "Default" },
      globalAgentConfig: {
        credential_mode: "byok",
        env_vars: {},
        model: null,
        preferred_runtime: "claude",
        provider: null,
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("onboarding-business")).toBeVisible({
    timeout: 15_000,
  });
  const steps = page.getByTestId("onboarding-step-counter");
  await expect(steps.locator('[aria-current="step"]')).toHaveText(
    "1 · Business",
  );
  await expect(steps).toContainText("2 · Power");
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();
  await fillSecondBusiness(page);
  await continueFounderBusiness(page);
  const openColony = page.getByRole("button", {
    name: "Open my Colony",
    exact: true,
  });
  // Finding a local account does not establish this business's connection.
  await expect(openColony).toBeDisabled();
  await page
    .getByRole("button", { name: "Connect Claude", exact: true })
    .click();
  const model = page.getByRole("combobox", { name: "Subscription model" });
  await expect(model).toBeVisible();
  await expect(openColony).toBeDisabled();
  await model.selectOption("claude-test-model");
  await expect(openColony).toBeEnabled();
  await openColony.click();
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0);
  await expectRetainedBusinessContext(page, {
    ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
    relayUrl: RELAY_URL,
    name: "Second Company",
    summary: "A second company with its own operating context.",
  });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
});

test("leaving an unfinished business preserves its answers and resumes on reload", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-exit");
  await installMockBridge(page, undefined, {
    relayWsUrl: RELAY_URL,
    skipOnboardingSeed: true,
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Your business" }),
  ).toBeVisible({ timeout: 15_000 });
  await fillSecondBusiness(page);
  await page.getByTestId("community-onboarding-exit").click();

  // The active overlay closes, while its owner/community draft remains resumable.
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
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((key) =>
          key.startsWith("colony.business-onboarding.v1:"),
        ).length,
    ),
  ).toBe(1);
  await page.reload();
  await expect(page.getByTestId("onboarding-business")).toBeVisible();
  await expect(page.getByLabel("Business name", { exact: true })).toHaveValue(
    "Second Company",
  );
  await expect(page.getByTestId("onboarding-account")).toHaveCount(0);
});

test("a zero balance never stands between a second company and its workspace", async ({
  page,
}) => {
  await seedCreatedCommunity(page, "additional-community-zero-credits");
  await installMockBridge(
    page,
    {
      communityProfileHead: { tradingName: "Default" },
      colonyCreditsAccount: ZERO_BALANCE,
      globalAgentConfig: {
        credential_mode: "colony_credits",
        env_vars: {},
        model: "deepseek-v4-flash",
        preferred_runtime: "buzz-agent",
        provider: "openai-compat",
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );

  await page.goto("/");

  await fillSecondBusiness(page);
  await openFounderBusiness(page);
  await expectRetainedBusinessContext(page, {
    ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
    relayUrl: RELAY_URL,
    name: "Second Company",
    summary: "A second company with its own operating context.",
  });
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
      provider: "openai-compat",
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
