import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import type { RelayEvent } from "../../src/shared/api/types";
import { KIND_DELEGATION_GRANT } from "../../src/shared/constants/kinds";

// Grant heads are trusted by authorship, and the mock relay's membership
// snapshot names the default mock identity as the community's only owner.
const OWNER_PUBKEY = "deadbeef".repeat(8);

const ACTIVE_GRANT: RelayEvent = {
  id: "mock-grant-copy-blog-titles".padEnd(64, "0"),
  pubkey: OWNER_PUBKEY,
  created_at: 1_800_000_000,
  kind: KIND_DELEGATION_GRANT,
  tags: [["d", "copy-blog-titles"]],
  content: JSON.stringify({
    category: "copy_change",
    scope: "blog_post_titles",
    active: true,
    cap_nano_usd: 25_000_000_000,
  }),
  sig: "mocksig".repeat(20).slice(0, 128),
};

const BAKED_DEFAULTS = [
  { key: "BUZZ_AGENT_PROVIDER", value: "anthropic", masked: false },
  {
    key: "BUZZ_AGENT_MODEL",
    value: "claude-opus-4-8",
    masked: false,
  },
  { key: "BUZZ_AGENT_THINKING_EFFORT", value: "high", masked: false },
  { key: "ANTHROPIC_API_KEY", value: "sk-ant-baked-test", masked: true },
];

// Edit-agent dialog coverage (Phase 1B.3b-pre). Written against TODAY'S
// EditAgentDialog, before the B3b re-host, so the re-host is guarded by a
// pre-existing spec rather than one written alongside it.
//
// Mock-boundary caveat: the e2eBridge `update_managed_agent` handler echoes
// name/model/systemPrompt/envVars/respondTo/respondToAllowlist into the
// mock store — it does NOT
// model the diff-based partial-update wire semantics (change-detected-or-omit,
// tri-state provider, harnessOverride derivation), and it ignores
// agentCommand/harnessOverride entirely. This spec therefore pins UI behavior
// (open → edit → save → persisted in UI), not wire semantics. The inherit
// toggle is not reachable here at all (see the routing pin below) — its
// behavior is covered by B3b's component-level pinning test (inherit-toggle
// → gate → submit); wire semantics stay component-test territory
// (personaRuntimeModel.test.mjs).

// Tyler's pubkey maps to ompSurface in the mock bridge (runtimeId "omp"),
// which supports LLM provider selection — same seed the readiness-screenshot
// spec uses for its edit-dialog shot.
const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const AGENT_NAME = "Tyler Agent";
const PERSONA_ID = "persona-edit-e2e";

/**
 * Open the Edit Agent dialog for the seeded managed agent via the profile
 * panel (agents view → agent card → Edit quick action) — EditAgentDialog's
 * only mount path.
 */
async function openEditDialog(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("open-agents-view").click();

  const agentButton = page.getByRole("button", {
    name: `${AGENT_NAME} agent profile`,
  });
  await expect(agentButton).toBeVisible({ timeout: 10_000 });
  await agentButton.click();

  await expect(page.getByTestId("user-profile-panel")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("user-profile-edit-agent").click();

  await expect(page.getByTestId("edit-agent-dialog")).toBeVisible({
    timeout: 10_000,
  });
  // Provider field visible = runtime catalog loaded and form settled.
  await expect(page.locator("#edit-agent-llm-provider")).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Pick an option from a PersonaDropdownField (menu-based, not a native
 * <select> — Create's fields are selects, Edit's are not).
 */
async function pickDropdownOption(
  page: import("@playwright/test").Page,
  triggerId: string,
  optionName: string | RegExp,
) {
  await page.locator(`#${triggerId}`).click();
  await page.getByRole("menuitemradio", { name: optionName }).click();
}

test.describe("agent definition dialog", () => {
  test("owner-only-access build shows disabled agent access with an explanation", async ({
    page,
  }) => {
    await installMockBridge(page, {
      ownerOnlyAccessBuild: true,
      bakedBuildEnv: BAKED_DEFAULTS,
    });
    await page.goto("/");
    await page.getByTestId("open-agents-view").click();
    await page.getByTestId("new-agent-card").click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Advanced", exact: true }).click();

    await expect(dialog.getByTestId("agent-respond-to")).toBeVisible();
    await expect(dialog.locator("#agent-respond-to")).toBeDisabled();
    await expect(dialog.locator("#agent-respond-to")).toContainText(
      "Only me (default)",
    );
    await expect(
      dialog.getByTestId("agent-respond-to-disabled-reason"),
    ).toHaveText("This build disallows changing this setting.");
  });
});

test.describe("edit agent dialog", () => {
  test("owner-only-access build shows a disabled owner-only access control with an explanation", async ({
    page,
  }) => {
    await installMockBridge(page, {
      ownerOnlyAccessBuild: true,
      bakedBuildEnv: BAKED_DEFAULTS,
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
          respondTo: "anyone",
        },
      ],
    });

    await openEditDialog(page);

    const accessControl = page.getByTestId("agent-respond-to");
    await expect(accessControl).toBeVisible();
    await expect(page.locator("#agent-respond-to")).toBeDisabled();
    await expect(page.locator("#agent-respond-to")).toContainText(
      "Only me (default)",
    );
    await expect(
      page.getByTestId("agent-respond-to-disabled-reason"),
    ).toHaveText("This build disallows changing this setting.");
  });

  test("OSS build keeps the managed-agent access control", async ({ page }) => {
    await installMockBridge(page, {
      bakedBuildEnv: BAKED_DEFAULTS,
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    await expect(page.getByTestId("agent-respond-to")).toBeVisible();
  });

  test("edits the agent name and persists it across a dialog reopen", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    const nameInput = page.locator("#edit-agent-name");
    await expect(nameInput).toHaveValue(AGENT_NAME);
    await nameInput.fill("Tyler Agent Renamed");

    await page.getByTestId("edit-agent-dialog-submit").click();
    await expect(page.getByTestId("edit-agent-dialog")).not.toBeVisible();

    // Reopen: the dialog re-reads the managed-agents store, proving the save
    // survived the dialog lifecycle rather than living in local state. (The
    // panel HEADER is not asserted — it renders the relay profile name, which
    // the update path does not touch.)
    await page.getByTestId("user-profile-edit-agent").click();
    await expect(page.locator("#edit-agent-name")).toHaveValue(
      "Tyler Agent Renamed",
      { timeout: 10_000 },
    );
  });

  test("changes the model via custom entry and persists it", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    // Pick a provider so model discovery has a scope, then set a custom model.
    await pickDropdownOption(page, "edit-agent-llm-provider", "Anthropic");
    await pickDropdownOption(page, "edit-agent-model", "Custom model...");
    await page.locator("#edit-agent-custom-model").fill("claude-opus-4-5");
    // Anthropic requires a credential before save unlocks.
    await page.getByLabel("Anthropic API Key").fill("sk-test-edit-agent-e2e");

    const submit = page.getByTestId("edit-agent-dialog-submit");
    await expect(submit).toBeEnabled({ timeout: 10_000 });
    await submit.click();
    await expect(page.getByTestId("edit-agent-dialog")).not.toBeVisible();

    await page.getByTestId("user-profile-edit-agent").click();
    await expect(page.getByTestId("edit-agent-dialog")).toBeVisible({
      timeout: 10_000,
    });
    // Custom model round-trips: the reopened dialog shows it in the custom
    // input (the discovered-model lists don't contain it).
    await expect(page.locator("#edit-agent-custom-model")).toHaveValue(
      "claude-opus-4-5",
      { timeout: 10_000 },
    );
  });

  test("keeps the custom command visible without opening Advanced", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    const advanced = page.getByRole("button", {
      name: "Advanced",
      exact: true,
    });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await pickDropdownOption(page, "edit-agent-runtime", "Custom command");
    await expect(page.locator("#edit-agent-command")).toBeVisible();
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
  });

  test("marks a missing advanced credential without opening Advanced", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    const advanced = page.getByRole("button", {
      name: "Advanced",
      exact: true,
    });
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await pickDropdownOption(page, "edit-agent-llm-provider", "Databricks v2");
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByTestId("edit-agent-advanced-required-badge"),
    ).toHaveText("Required");
    await expect(page.getByTestId("edit-agent-dialog-submit")).toBeDisabled();

    await advanced.click();
    await expect(page.getByLabel("Value for DATABRICKS_HOST")).toBeVisible();
  });

  test("shows baked defaults in the instance editor", async ({ page }) => {
    await installMockBridge(page, {
      bakedBuildEnv: BAKED_DEFAULTS,
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    await expect(page.locator("#edit-agent-llm-provider")).toHaveText(
      "Anthropic (inherited from build)",
    );
    await expect(page.locator("#edit-agent-model")).toHaveText(
      "Inherit build default (claude-opus-4-8)",
    );
    const defaults = page.getByTestId("agent-ai-defaults-notice");
    await expect(
      defaults.getByText("Anthropic", { exact: true }),
    ).toBeVisible();
    await expect(
      defaults.getByText("claude-opus-4-8", { exact: true }),
    ).toBeVisible();
  });

  test("explicit global defaults override baked labels in the instance editor", async ({
    page,
  }) => {
    await installMockBridge(page, {
      bakedBuildEnv: BAKED_DEFAULTS,
      globalAgentConfig: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        env_vars: { BUZZ_AGENT_THINKING_EFFORT: "low" },
      },
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
    });

    await openEditDialog(page);

    await expect(page.locator("#edit-agent-llm-provider")).toHaveText(
      "Use agent defaults (anthropic)",
    );
    await expect(page.locator("#edit-agent-model")).toHaveText(
      "Use agent defaults (claude-opus-4-5)",
    );
    const defaults = page.getByTestId("agent-ai-defaults-notice");
    await expect(
      defaults.getByText("Anthropic", { exact: true }),
    ).toBeVisible();
    await expect(
      defaults.getByText("claude-opus-4-5", { exact: true }),
    ).toBeVisible();
  });

  test("profile Edit routes persona-linked agents to the definition editor", async ({
    page,
  }) => {
    // Routing pin for handleEditAgent (UserProfilePanel): when the agent has
    // a resolvable non-built-in persona, the Edit quick action opens the
    // DEFINITION editor (persona dialog), not EditAgentDialog. The instance
    // editor (and its inherit-runtime toggle) is reachable for persona-linked
    // agents only via the requestOpenEditAgent event (ConfigNudgeCard) — no
    // plain UI path — so its inherit-toggle behavior is covered by B3b's
    // component-level pinning test, not e2e.
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          personaId: PERSONA_ID,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
      personas: [
        {
          id: PERSONA_ID,
          displayName: "Edit E2E Persona",
          systemPrompt: "You are the edit-agent e2e persona.",
        },
      ],
    });

    await page.goto("/");
    await page.getByTestId("open-agents-view").click();

    // Persona-linked agents render grouped under the persona's card name.
    const agentButton = page.getByRole("button", {
      name: "Edit E2E Persona agent profile",
    });
    await expect(agentButton).toBeVisible({ timeout: 10_000 });
    await agentButton.click();

    await expect(page.getByTestId("user-profile-panel")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId("user-profile-edit-agent").click();

    // Definition editor opens; the instance editor does not.
    await expect(page.getByTestId("persona-dialog")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("edit-agent-dialog")).not.toBeVisible();
    // And it is the persona's record that's being edited.
    await expect(page.locator("#persona-display-name")).toHaveValue(
      "Edit E2E Persona",
    );
  });

  test("shows org placement and publishes a rank change", async ({ page }) => {
    await installMockBridge(page, {
      // The org chart only trusts a kind-30177 head authored by a community
      // owner. The mock relay's NIP-43 membership snapshot makes the default
      // mock identity that owner, and the seeded head carries its pubkey.
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
      managedAgentHeads: [
        { pubkey: AGENT_PUBKEY, name: AGENT_NAME, tier: "worker" },
      ],
    });

    await openEditDialog(page);

    // Seeded from the chart, not from the managed-agent record: the record
    // carries no rank at all.
    const rankSelect = page.getByTestId("agent-org-rank-select");
    await expect(rankSelect).toBeVisible();
    await expect(rankSelect).toHaveAttribute("data-value", "worker", {
      timeout: 10_000,
    });
    await expect(
      page.getByTestId("edit-agent-org-placement-pending"),
    ).toHaveCount(0);

    await rankSelect.click();
    await page.getByTestId("agent-org-rank-select-option-leader").click();
    await expect(rankSelect).toHaveAttribute("data-value", "leader");

    // Worker to team lead is a promotion, so it must say what it confers --
    // and with no grants active, say exactly that rather than blocking.
    await expect(page.getByTestId("promotion-grant-warning")).toBeVisible();
    await expect(page.getByTestId("promotion-no-grants")).toBeVisible();
    await expect(page.getByTestId("edit-agent-dialog-submit")).toBeEnabled();

    await page.getByTestId("edit-agent-dialog-submit").click();
    await expect(page.getByTestId("edit-agent-dialog")).not.toBeVisible();

    // The rank is a second write on the relay, so the proof is the published
    // head, not anything the update mutation echoed back.
    const published = await page.waitForFunction(
      (pubkey) => {
        type PublishedEvent = {
          kind: number;
          content: string;
          tags: string[][];
        };
        const events =
          (
            window as unknown as {
              __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
            }
          ).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [];
        return (
          events.find(
            (event) =>
              event.kind === 30177 &&
              event.tags.some((tag) => tag[0] === "d" && tag[1] === pubkey),
          ) ?? null
        );
      },
      AGENT_PUBKEY,
      { timeout: 10_000 },
    );
    const head = await published.jsonValue();
    expect(JSON.parse(head.content).tier).toBe("leader");
    // A team lead reports to a chief of staff, and none is seeded, so the
    // head must carry no reporting line rather than an invented one.
    expect(head.tags.some((tag) => tag[0] === "manager")).toBe(false);
  });

  test("blocks a promotion that confers grants until it is acknowledged", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: AGENT_NAME,
          status: "stopped",
          channelNames: ["agents"],
        },
      ],
      managedAgentHeads: [
        { pubkey: AGENT_PUBKEY, name: AGENT_NAME, tier: "worker" },
      ],
      delegationGrantEvents: [ACTIVE_GRANT],
    });

    await openEditDialog(page);

    const rankSelect = page.getByTestId("agent-org-rank-select");
    await expect(rankSelect).toHaveAttribute("data-value", "worker", {
      timeout: 10_000,
    });
    const submit = page.getByTestId("edit-agent-dialog-submit");
    await expect(submit).toBeEnabled();

    await rankSelect.click();
    await page.getByTestId("agent-org-rank-select-option-leader").click();

    // Promoting hands over every active delegation at once, so the whole
    // save is refused until the owner has seen which ones.
    await expect(page.getByTestId("promotion-grant-warning")).toBeVisible();
    await expect(
      page.getByTestId("promotion-grant-copy-blog-titles"),
    ).toBeVisible();
    await expect(submit).toBeDisabled();

    await page.getByTestId("promotion-acknowledge-checkbox").click();
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect(page.getByTestId("edit-agent-dialog")).not.toBeVisible();

    const published = await page.waitForFunction(
      (pubkey) => {
        type PublishedEvent = {
          kind: number;
          content: string;
          tags: string[][];
        };
        const events =
          (
            window as unknown as {
              __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
            }
          ).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [];
        return (
          events.find(
            (event) =>
              event.kind === 30177 &&
              event.tags.some((tag) => tag[0] === "d" && tag[1] === pubkey),
          ) ?? null
        );
      },
      AGENT_PUBKEY,
      { timeout: 10_000 },
    );
    expect(JSON.parse((await published.jsonValue()).content).tier).toBe(
      "leader",
    );
  });
});
