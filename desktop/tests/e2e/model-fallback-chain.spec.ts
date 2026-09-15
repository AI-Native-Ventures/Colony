/**
 * The fallback chain, end to end in the two places an owner edits it.
 *
 * What these cover that a unit test cannot: the chain survives a save and a
 * reopen in the order the owner left it, and a per-agent chain starts from what
 * the agent inherits instead of from nothing.
 */
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const PRIMARY = "z/primary:free";
const DISCOVERED = [
  { id: PRIMARY, name: "Primary" },
  { id: "a/one:free", name: "One" },
  { id: "b/two:free", name: "Two" },
  { id: "c/three:free", name: "Three" },
];
const RELAY_CHAIN = ["a/one:free", "b/two:free"];

function openRouterConfig(fallbackModels: string[]) {
  return {
    credential_mode: "byok" as const,
    env_vars: { OPENROUTER_API_KEY: "sk-test" },
    fallback_models: fallbackModels,
    model: PRIMARY,
    preferred_runtime: "buzz-agent",
    provider: "openrouter",
  };
}

function chainMock(fallbackModels: string[]) {
  return {
    discoverAgentModels: { models: DISCOVERED, supportsSwitching: true },
    globalAgentConfig: openRouterConfig(fallbackModels),
    recommendedModelChain: RELAY_CHAIN,
  };
}

/**
 * Open the Agent defaults dialog from the agents view.
 *
 * Reopening never navigates: the mock bridge rebuilds its stores on load, so a
 * reload would wipe the very save these tests are checking survived.
 */
async function openAgentDefaults(page: import("@playwright/test").Page) {
  await page.getByTestId("agent-defaults-button").click();
  const dialog = page.getByTestId("agent-ai-defaults-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("model-chain-field")).toBeVisible({
    timeout: 10_000,
  });
  await waitForAnimations(page);
  return dialog;
}

/** The ids in the chain rows, top to bottom. */
async function chainValues(
  scope: import("@playwright/test").Locator,
): Promise<string[]> {
  const rows = scope.locator('[data-testid^="agent-fallback-model-"]');
  return rows.evaluateAll((nodes) =>
    nodes
      .filter((node) => node.getAttribute("role") === "combobox")
      .map((node) => node.getAttribute("data-value") ?? ""),
  );
}

async function pickFallback(
  page: import("@playwright/test").Page,
  index: number,
  modelId: string,
) {
  await page.getByTestId(`agent-fallback-model-${index}`).click();
  await page
    .getByTestId(`agent-fallback-model-${index}-option-${modelId}`)
    .click();
}

test("an authored chain survives a save and reopen in the owner's order", async ({
  page,
}) => {
  await installMockBridge(page, chainMock([]));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();

  let dialog = await openAgentDefaults(page);
  const field = dialog.getByTestId("model-chain-field");
  // With nothing authored, the field shows the relay's chain read-only.
  await expect(field).toContainText("a/one:free");
  await expect(field).toContainText("b/two:free");
  await expect(field.getByTestId("model-chain-customize")).toBeVisible();

  await field.getByTestId("model-chain-customize").click();
  expect(await chainValues(field)).toEqual(RELAY_CHAIN);

  // Add a third entry, then move it above the second with the keyboard button.
  await field.getByTestId("model-chain-add").click();
  await pickFallback(page, 2, "c/three:free");
  await field.getByRole("button", { name: "Move fallback 3 up" }).click();
  const authored = ["a/one:free", "c/three:free", "b/two:free"];
  expect(await chainValues(field)).toEqual(authored);

  // A successful save closes the dialog, which is the save's own signal.
  await dialog.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.getByTestId("agent-ai-defaults-dialog")).toHaveCount(0, {
    timeout: 10_000,
  });

  dialog = await openAgentDefaults(page);
  expect(await chainValues(dialog.getByTestId("model-chain-field"))).toEqual(
    authored,
  );
  // Still authored, so the field offers the way back rather than Customize.
  await expect(dialog.getByTestId("model-chain-use-recommended")).toBeVisible();
});

test("the relay chain is read-only until the owner takes it over", async ({
  page,
}) => {
  await installMockBridge(page, chainMock([]));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  const dialog = await openAgentDefaults(page);
  const field = dialog.getByTestId("model-chain-field");

  await expect(field.getByTestId("model-chain-add")).toHaveCount(0);
  await expect(
    field.locator('[data-testid^="agent-fallback-model-"]'),
  ).toHaveCount(0);
  await field.getByTestId("model-chain-customize").click();
  await expect(field.getByTestId("model-chain-add")).toBeVisible();
});

test("an agent's Customize tab starts from the chain it inherits", async ({
  page,
}) => {
  const globalChain = ["a/one:free", "b/two:free"];
  await installMockBridge(page, {
    ...chainMock(globalChain),
    personas: [
      {
        id: "custom:chain-agent",
        displayName: "Chain Agent",
        isActive: true,
        systemPrompt: "An agent for fallback chain tests.",
        provider: "openrouter",
        model: PRIMARY,
        runtime: "buzz-agent",
      },
    ],
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("agents-library-personas")).toBeVisible({
    timeout: 10_000,
  });

  // Same rule as above: reopen through the UI, never through a reload.
  async function openCustomizeTab() {
    await page
      .getByRole("button", { name: "Open actions for Chain Agent" })
      .click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const dialog = page.getByTestId("persona-dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("tab", { name: "Customize for this agent" }).click();
    await expect(dialog.getByTestId("model-chain-field")).toBeVisible({
      timeout: 10_000,
    });
    await waitForAnimations(page);
    return dialog;
  }

  let dialog = await openCustomizeTab();
  const field = dialog.getByTestId("model-chain-field");
  // Inherited from the owner's global chain, not from the relay's.
  await expect(field).toContainText("a/one:free");
  await expect(field).toContainText("b/two:free");

  await field.getByTestId("model-chain-customize").click();
  expect(await chainValues(field)).toEqual(globalChain);
  await field.getByRole("button", { name: "Remove fallback 1" }).click();
  expect(await chainValues(field)).toEqual(["b/two:free"]);

  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("persona-dialog")).toHaveCount(0, {
    timeout: 10_000,
  });

  dialog = await openCustomizeTab();
  expect(await chainValues(dialog.getByTestId("model-chain-field"))).toEqual([
    "b/two:free",
  ]);
});
