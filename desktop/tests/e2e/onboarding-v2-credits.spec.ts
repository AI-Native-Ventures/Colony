import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const TRANSACTION_STORAGE_KEY = "buzz-community-onboarding-transaction.v1";
const RELAY_URL = "wss://default.example.com";
const ZERO_BALANCE = {
  balance_nanousd: "0",
  currency: "USD" as const,
  status: "depleted" as const,
};

test("zero-credit Colony Agent onboarding reaches the first task without payment UI", async ({
  page,
}) => {
  const identity = { ...TEST_IDENTITIES.tyler, username: "" };
  await seedActiveIdentity(page, identity);
  await page.addInitScript(
    ({ pubkey, storageKey }) => {
      window.localStorage.setItem(
        `buzz-machine-onboarding-complete.v2:${pubkey}`,
        "true",
      );
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({
          addedCommunity: true,
          communityId: "e2e-default-community",
          communityName: "E2E Test",
          createdAt: timestamp,
          id: "zero-credit-first-task",
          onboardingV2: {
            company: {
              canonicalUrl: "https://example.com/",
              hasWebsite: true,
              scanStatus: "success",
              summary: "A test company for the onboarding credit path.",
              website: "https://example.com",
            },
            credits: {
              balanceNanousd: "0",
              status: "depleted",
            },
            firstTask: {
              content: "Review our launch plan.",
              deliveredEventId: null,
              deliveryMarker: "e2e-zero-credit-first-task",
            },
            founder: {
              city: "Johannesburg",
              country: "South Africa",
              fullName: "Basheer Phiri",
              gender: null,
              selfDescribedGender: "",
            },
            runtime: {
              model: "deepseek-v4-flash",
              route: "colony-agent",
              selectedId: "buzz-agent",
            },
            stage: "first-task",
            version: 1,
          },
          relayUrl: "wss://default.example.com",
          source: "first-community",
          stage: "profile",
          updatedAt: timestamp,
        }),
      );
    },
    { pubkey: identity.pubkey, storageKey: TRANSACTION_STORAGE_KEY },
  );
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

  await expect
    .poll(() =>
      page.evaluate((storageKey) => {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return null;
        const transaction = JSON.parse(raw) as {
          onboardingV2?: { stage?: string };
        };
        return transaction.onboardingV2?.stage ?? null;
      }, TRANSACTION_STORAGE_KEY),
    )
    .toBe("first-task");
  await expect(
    page.getByRole("heading", { name: "What should Scout move first?" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-zero-credits-warning")).toHaveText(
    "You can enter Colony now. Scout and other agents will not respond until you add credits. Your balance is always visible beside your profile.",
  );
  await expect(page.getByText(/link a card/i)).toHaveCount(0);
  await expect(page.getByText(/payment method/i)).toHaveCount(0);
  const startCompany = page.getByRole("button", { name: "Start my company" });
  await expect(startCompany).toBeEnabled();
  await startCompany.click();
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0, {
    timeout: 10_000,
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
