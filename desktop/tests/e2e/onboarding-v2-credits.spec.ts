import { expect, test, type Page } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  continueFounderBusiness,
} from "../helpers/onboarding";
import { fillFounderBusiness } from "../helpers/simpleFounder";
import {
  parseScoutOnboardingRoot,
  ROOT_PROTOCOL,
} from "../../src/features/onboarding/channelOnboardingRuntime/protocol";

/** Additional-business completion and live balance remain independent. */

const TRANSACTION_STORAGE_KEY = "buzz-community-onboarding-transaction.v1";
const RELAY_URL = "wss://default.example.com";
const ZERO_BALANCE = {
  balance_nanousd: "0",
  currency: "USD" as const,
  status: "depleted" as const,
};

const PRE_APPROVAL_SETUP_COMMANDS = [
  "attach_thread_task",
  "create_managed_agent",
  "create_team",
  "create_user_task",
  "execute_agent_proposal",
  "publish_note",
  "send_managed_agent_channel_message",
  "send_stream_message",
  "set_canvas",
  "set_thread_canvas",
  "start_managed_agent",
  "start_managed_agent_runtime",
  "update_company_profile",
];

async function expectChoiceFirstRoot(
  page: Page,
  commandCountBeforeChoiceHandoff: number,
  expected: {
    ownerPubkey: string;
    relayUrl: string;
    businessName: string;
    businessDescription: string;
  },
) {
  const retained = await page.evaluate(() => ({
    published: window.__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
    signedProfileUpdates: window.__BUZZ_E2E_COMMAND_PAYLOADS__?.filter(
      (entry) => entry.command === "sign_community_profile_update",
    ),
    commands: window.__BUZZ_E2E_COMMANDS__ ?? [],
  }));
  const roots = retained.published.filter((event) =>
    event.tags.some(
      (tag) => tag[0] === "client" && tag[1] === ROOT_PROTOCOL.marker,
    ),
  );
  expect(roots).toHaveLength(1);
  const root = roots[0];
  expect(root?.kind).toBe(ROOT_PROTOCOL.kind);
  if (!root) throw new Error("Missing signed Scout onboarding root");
  expect(verifyEvent(root)).toBe(true);
  const payload = parseScoutOnboardingRoot(root.tags);
  expect(payload).not.toBeNull();
  if (!payload) throw new Error("The Scout onboarding root was not readable");
  expect(payload).toMatchObject({
    ownerPubkey: expected.ownerPubkey,
    relayUrl: expected.relayUrl,
    seed: {
      businessName: expected.businessName,
      businessDescription: expected.businessDescription,
      website: "",
      websiteState: "none",
    },
  });
  expect(payload.requestId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
  expect(retained.signedProfileUpdates ?? []).toHaveLength(0);
  const postHandoffCommands = retained.commands.slice(
    commandCountBeforeChoiceHandoff,
  );
  for (const command of PRE_APPROVAL_SETUP_COMMANDS) {
    expect(postHandoffCommands).not.toContain(command);
  }
}

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
  await expect(steps.locator('[aria-current="step"]')).toHaveText("1Business");
  await expect(steps).toContainText("2Connect and test");
  await expect(page.getByTestId("community-onboarding-exit")).toBeVisible();
  await fillSecondBusiness(page);
  await continueFounderBusiness(page);
  const openColony = page.getByRole("button", {
    name: "Test connection",
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
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const commandCountBeforeChoiceHandoff = await page.evaluate(
    () => window.__BUZZ_E2E_COMMANDS__?.length ?? 0,
  );
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0);
  await expectChoiceFirstRoot(page, commandCountBeforeChoiceHandoff, {
    ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
    relayUrl: RELAY_URL,
    businessName: "Second Company",
    businessDescription: "A second company with its own operating context.",
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
  await continueFounderBusiness(page);
  const openColony = page.getByRole("button", {
    name: "Test connection",
    exact: true,
  });
  await expect(openColony).toBeEnabled();
  await openColony.click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const commandCountBeforeChoiceHandoff = await page.evaluate(
    () => window.__BUZZ_E2E_COMMANDS__?.length ?? 0,
  );
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  await expectChoiceFirstRoot(page, commandCountBeforeChoiceHandoff, {
    ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
    relayUrl: RELAY_URL,
    businessName: "Second Company",
    businessDescription: "A second company with its own operating context.",
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
