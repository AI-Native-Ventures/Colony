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

function runtime(
  id: "buzz-agent" | "claude" | "codex",
  availability: string,
  authStatus: Record<string, unknown>,
) {
  return {
    id,
    label:
      id === "buzz-agent"
        ? "Colony Agent"
        : id === "claude"
          ? "Claude Code"
          : "Codex",
    avatar_url: "",
    availability,
    command: availability === "available" ? id : null,
    binary_path: availability === "available" ? `/usr/local/bin/${id}` : null,
    default_args: [],
    mcp_command: null,
    install_hint: `Install ${id}`,
    install_instructions_url: "https://example.com",
    can_auto_install: true,
    underlying_cli_path: null,
    node_required: false,
    auth_status: authStatus,
    login_hint: `Sign in to ${id}`,
  };
}

async function seedRuntimeCheck(
  page: Parameters<typeof seedActiveIdentity>[0],
) {
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
          id: "automatic-runtime-selection",
          onboardingV2: {
            company: {
              canonicalUrl: "https://example.com/",
              hasWebsite: true,
              scanStatus: "success",
              summary: "A test company ready for automatic runtime setup.",
              website: "https://example.com",
            },
            credits: {
              balanceNanousd: null,
              status: "unavailable",
            },
            firstTask: {
              content: "",
              deliveredEventId: null,
              deliveryMarker: "e2e-automatic-runtime",
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
              route: null,
              selectedId: null,
            },
            stage: "runtime-check",
            version: 1,
          },
          relayUrl: "wss://default.example.com",
          // The returning-founder journey, which is the one V2 still serves.
          // First-run belongs to the redesigned flow now, and showing both
          // meant asking for the founder's details twice in one sitting.
          source: "create-community",
          stage: "profile",
          updatedAt: timestamp,
        }),
      );
    },
    { pubkey: identity.pubkey, storageKey: TRANSACTION_STORAGE_KEY },
  );
}

async function readGlobalConfig(page: Parameters<typeof installMockBridge>[0]) {
  return await page.evaluate(async () => {
    return await (
      window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          command: string,
          payload: unknown,
        ) => Promise<{
          credential_mode?: string;
          preferred_runtime?: string | null;
        }>;
      }
    ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("get_global_agent_config", null);
  });
}

async function readGlobalConfigSetterCallCount(
  page: Parameters<typeof installMockBridge>[0],
) {
  return await page.evaluate(async () => {
    return await (
      window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          command: string,
          payload: unknown,
        ) => Promise<number>;
      }
    ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.(
      "get_global_agent_config_set_call_count",
      null,
    );
  });
}

test("a created community uses the returning-founder V2 journey", async ({
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
          communityId: "e2e-created-community",
          communityName: "Second Company",
          createdAt: timestamp,
          id: "additional-community-v2",
          onboardingV2: {
            company: {
              canonicalUrl: "",
              hasWebsite: true,
              scanStatus: "idle",
              summary: "",
              website: "",
            },
            credits: {
              balanceNanousd: null,
              status: "unavailable",
            },
            firstTask: {
              content: "",
              deliveredEventId: null,
              deliveryMarker: "e2e-additional-community",
            },
            founder: {
              city: "",
              country: "",
              fullName: "",
              gender: null,
              selfDescribedGender: "",
            },
            runtime: {
              model: "deepseek-v4-flash",
              route: null,
              selectedId: null,
            },
            stage: "website",
            version: 1,
          },
          relayUrl: "wss://default.example.com",
          source: "create-community",
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

  await expect(
    page.getByRole("heading", { name: "Show Colony the business" }),
  ).toBeVisible();
  await expect(page.getByText("Step 1 of 3")).toBeVisible();
  await expect(page.getByTestId("onboarding-v2-progress")).toHaveCount(1);

  await page
    .getByRole("textbox", { name: /What does the business do/ })
    .fill("A second company with its own operating context.");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(
    page.getByRole("heading", { name: "Meet Scout, your Chief of Staff" }),
  ).toBeVisible();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await page
    .getByRole("textbox", { name: /First task for Scout/ })
    .fill("Prepare the first-week operating plan.");
  await page.getByRole("button", { name: "Start this company" }).click();

  await expect(page.getByTestId("community-onboarding-flow")).toHaveCount(0, {
    timeout: 10_000,
  });
});

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
          // The returning-founder journey, which is the one V2 still serves.
          // First-run belongs to the redesigned flow now, and showing both
          // meant asking for the founder's details twice in one sitting.
          source: "create-community",
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
    .toBe("scout-task");
  await expect(
    page.getByRole("heading", { name: "Meet Scout, your Chief of Staff" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-zero-credits-warning")).toHaveText(
    "You can enter Colony now. Scout and other agents will not respond until you add credits. Your balance is always visible beside your profile.",
  );
  await expect(page.getByText(/link a card/i)).toHaveCount(0);
  await expect(page.getByText(/payment method/i)).toHaveCount(0);
  // "Start this company" is the returning-founder wording; the first-run
  // journey said "Start my company" and belongs to the redesigned flow now.
  const startCompany = page.getByRole("button", {
    name: "Start this company",
  });
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

test("automatic setup selects the first ready supported CLI without a chooser", async ({
  page,
}) => {
  await seedRuntimeCheck(page);
  await installMockBridge(
    page,
    {
      acpRuntimesCatalog: [
        runtime("claude", "available", { status: "logged_in" }),
        runtime("codex", "available", { status: "logged_in" }),
        runtime("buzz-agent", "available", { status: "not_applicable" }),
      ],
      globalAgentConfig: {
        credential_mode: "byok",
        env_vars: {},
        model: null,
        preferred_runtime: null,
        provider: null,
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );

  await page.goto("/");

  await expect(page.getByText("codex is connected")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("onboarding-runtime-codex")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect
    .poll(() => readGlobalConfig(page))
    .toMatchObject({ credential_mode: "byok", preferred_runtime: "codex" });
  await expect.poll(() => readGlobalConfigSetterCallCount(page)).toBe(1);
});

test("automatic setup offers Colony Agent when no supported CLI is ready", async ({
  page,
}) => {
  await seedRuntimeCheck(page);
  await installMockBridge(
    page,
    {
      acpRuntimesCatalog: [
        runtime("codex", "available", { status: "logged_out" }),
        runtime("claude", "not_installed", { status: "unknown" }),
        runtime("buzz-agent", "available", { status: "not_applicable" }),
      ],
      globalAgentConfig: {
        credential_mode: "byok",
        env_vars: {},
        model: null,
        preferred_runtime: null,
        provider: null,
      },
    },
    { relayWsUrl: RELAY_URL, skipOnboardingSeed: true },
  );

  await page.goto("/");

  await expect(page.getByRole("button", { name: "Install" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Colony Agent", { exact: true })).toBeVisible();
  await expect(page.getByTestId("onboarding-runtime-codex")).toHaveCount(0);
  await expect(await readGlobalConfig(page)).toMatchObject({
    credential_mode: "byok",
    preferred_runtime: null,
  });
  expect(await readGlobalConfigSetterCallCount(page)).toBe(0);
});
