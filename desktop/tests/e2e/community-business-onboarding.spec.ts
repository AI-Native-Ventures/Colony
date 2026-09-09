import { expect, test, type Page } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  continueFounderBusiness,
} from "../helpers/onboarding";
import { fillFounderBusiness } from "../helpers/simpleFounder";
import { waitForAnimations } from "../helpers/animations";

const OWNER = TEST_IDENTITIES.tyler.pubkey;
const BASE_RELAY = "wss://alpha.colony.ainative.ventures";
const CREDIT_CONFIG = {
  credential_mode: "colony_credits" as const,
  env_vars: {},
  model: "deepseek-v4-flash",
  preferred_runtime: "buzz-agent",
  provider: "openai-compat",
};

async function existingOwner(page: Page) {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await page.addInitScript(
    ({ owner, relay }) => {
      if (localStorage.getItem("business-onboarding-fixture-seeded")) return;
      localStorage.setItem("business-onboarding-fixture-seeded", "true");
      localStorage.setItem(
        "buzz-communities",
        JSON.stringify([
          {
            id: "alpha",
            name: "Alpha",
            relayUrl: relay,
            pubkey: owner,
            addedAt: new Date().toISOString(),
          },
        ]),
      );
      localStorage.setItem("buzz-active-community-id", "alpha");
      localStorage.setItem(
        `buzz-machine-onboarding-complete.v2:${owner}`,
        "true",
      );
      localStorage.setItem(`buzz-onboarding-complete.v1:${owner}`, "true");
      localStorage.setItem(
        `buzz-community-onboarding-complete.v1:${encodeURIComponent(relay)}:${owner}`,
        "true",
      );
    },
    { owner: OWNER, relay: BASE_RELAY },
  );
  await installMockBridge(
    page,
    {
      globalAgentConfig: CREDIT_CONFIG,
      colonyCommunities: [
        {
          id: "alpha",
          name: "Alpha",
          slug: "alpha",
          normalized_host: "alpha.colony.ainative.ventures",
        },
      ],
    },
    { skipCommunitySeed: true, relayWsUrl: BASE_RELAY },
  );
  await page.goto("/");
  await expect(page.getByTestId("community-rail-add")).toBeVisible();
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );
  await page.evaluate(() =>
    window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("update_profile", {
      displayName: "Tyler Owner",
    }),
  );
  const profile = (await page.evaluate(() =>
    window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("get_profile"),
  )) as { has_profile_event: boolean };
  expect(profile.has_profile_event).toBe(true);
}

async function createFromRail(page: Page, slug: string) {
  await page.getByTestId("community-rail-add").click();
  await page.getByTestId("add-community-create").click();
  await page.getByTestId("hosted-community-create-name").fill(slug);
  await page.getByTestId("hosted-community-create-submit").click();
  await expect(page.getByTestId("onboarding-business")).toBeVisible();
  await expect(page.getByTestId("onboarding-account")).toHaveCount(0);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
}

test("a named owner creates from the real rail, resumes Business and Power, and completes only this business", async ({
  page,
}) => {
  await existingOwner(page);
  await createFromRail(page, "bravo");
  await fillFounderBusiness(
    page,
    "Bravo Studio",
    "We design brands for service businesses.",
  );
  await page.getByTestId("community-onboarding-exit").click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0);
  const saved = await page.evaluate(
    (owner) => ({
      pending: Object.keys(localStorage).filter((key) =>
        key.startsWith("colony.business-onboarding.v1:"),
      ),
      completed: localStorage.getItem(
        `buzz-community-onboarding-complete.v1:${encodeURIComponent("wss://bravo.colony.ainative.ventures")}:${owner}`,
      ),
      commands: window.__BUZZ_E2E_COMMANDS__ ?? [],
    }),
    OWNER,
  );
  expect(saved.commands).not.toContain("start_managed_agent");
  expect(saved.commands.some((command) => command.includes("checkout"))).toBe(
    false,
  );
  expect(saved.pending).toHaveLength(1);
  expect(saved.completed).toBeNull();
  await page.reload();
  await expect(page.getByLabel("Business name", { exact: true })).toHaveValue(
    "Bravo Studio",
  );
  await continueFounderBusiness(page);
  await page.reload();
  await expect(page.getByTestId("onboarding-power")).toBeVisible();
  await expect(page.getByTestId("onboarding-account")).toHaveCount(0);
  // The mock's profile store spans relays; explicitly make the target unnamed
  // to exercise production's fresh-relay profile state before handoff.
  await page.evaluate(() =>
    window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("update_profile", {
      displayName: "",
    }),
  );
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/community-business-power.png" });
  await page
    .getByRole("button", { name: "Open my Colony", exact: true })
    .click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0, { timeout: 30_000 });
  const state = await page.evaluate(
    ({ owner, relay }) => ({
      baseComplete: localStorage.getItem(
        `buzz-community-onboarding-complete.v1:${encodeURIComponent(relay)}:${owner}`,
      ),
      newComplete: localStorage.getItem(
        `buzz-community-onboarding-complete.v1:${encodeURIComponent("wss://bravo.colony.ainative.ventures")}:${owner}`,
      ),
      pending: Object.keys(localStorage).filter((key) =>
        key.startsWith("colony.business-onboarding.v1:"),
      ),
      commands: window.__BUZZ_E2E_COMMANDS__ ?? [],
    }),
    { owner: OWNER, relay: BASE_RELAY },
  );
  const targetProfile = (await page.evaluate(() =>
    window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("get_profile"),
  )) as { display_name: string; has_profile_event: boolean };
  expect(targetProfile.display_name).toBe("Tyler Owner");
  expect(targetProfile.has_profile_event).toBe(true);
  expect(state.baseComplete).toBe("true");
  expect(state.newComplete).toBe("true");
  expect(state.pending).toHaveLength(0);
  expect(state.commands).not.toContain("start_managed_agent");
  expect(state.commands.some((command) => command.includes("checkout"))).toBe(
    false,
  );
});

test("an already skipped owned business has an explicit setup recovery action", async ({
  page,
}) => {
  await existingOwner(page);
  await page.getByTestId("sidebar-workspace-switcher").click();
  await page.getByTestId("finish-business-setup").click();
  await expect(page.getByTestId("onboarding-business")).toBeVisible();
  await expect(page.getByTestId("onboarding-account")).toHaveCount(0);
  await fillFounderBusiness(page, "Alpha", "Our original business context.");
  await continueFounderBusiness(page);
  await expect(page.getByTestId("onboarding-power")).toBeVisible();
});
