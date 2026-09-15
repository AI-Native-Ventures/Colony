/**
 * The Customize tab of the agent dialog, as the owner meets it.
 *
 * What a unit test cannot cover: switching to Customize on an agent that runs
 * on the defaults leaves every row inherited with Save already enabled, an
 * edit flips exactly one pill, Reset puts it back, and a save that changed
 * nothing writes no pins onto the agent.
 */
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const MODEL = "z/primary:free";
const DISCOVERED = [
  { id: MODEL, name: "Primary" },
  { id: "a/one:free", name: "One" },
];

const ROWS = ["harness", "provider", "model", "fallbacks", "reasoning"];

async function openCustomizeTab(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: "Open actions for Defaults Agent" })
    .click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("tab", { name: "Customize for this agent" }).click();
  await expect(dialog.getByTestId("customize-ai-rows")).toBeVisible({
    timeout: 10_000,
  });
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    discoverAgentModels: { models: DISCOVERED, supportsSwitching: true },
    globalAgentConfig: {
      credential_mode: "byok" as const,
      env_vars: { OPENROUTER_API_KEY: "sk-test" },
      fallback_models: [],
      model: MODEL,
      preferred_runtime: "buzz-agent",
      provider: "openrouter",
    },
    personas: [
      {
        id: "custom:defaults-agent",
        displayName: "Defaults Agent",
        isActive: true,
        systemPrompt: "An agent that runs on the agent defaults.",
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("agents-library-personas")).toBeVisible({
    timeout: 10_000,
  });
});

test("Customize opens on the inherited values with Save enabled", async ({
  page,
}) => {
  const dialog = await openCustomizeTab(page);

  for (const row of ROWS) {
    await expect(dialog.getByTestId(`customize-ai-pill-${row}`)).toHaveText(
      "inherited",
    );
  }
  // The old tab opened with an empty provider and model behind a required
  // star, which disabled Save on an agent that was running fine.
  await expect(dialog.getByTestId("customize-ai-row-provider")).toContainText(
    "OpenRouter",
  );
  await expect(dialog.getByTestId("customize-ai-row-model")).toContainText(
    MODEL,
  );
  await expect(dialog.getByTestId("customize-ai-note-provider")).toHaveText(
    "Key: from defaults",
  );
  await expect(dialog.getByTestId("persona-dialog-submit")).toBeEnabled({
    timeout: 10_000,
  });
});

test("changing a row marks it custom, and Reset returns it to inherited", async ({
  page,
}) => {
  const dialog = await openCustomizeTab(page);

  await dialog.getByTestId("customize-ai-change-model").click();
  await dialog.locator("#persona-model").click();
  await page.getByRole("button", { name: "One", exact: true }).click();

  await expect(dialog.getByTestId("customize-ai-pill-model")).toHaveText(
    "custom",
  );
  await expect(dialog.getByTestId("customize-ai-pill-provider")).toHaveText(
    "inherited",
  );

  await dialog.getByTestId("customize-ai-reset-model").click();
  await expect(dialog.getByTestId("customize-ai-pill-model")).toHaveText(
    "inherited",
  );
  await expect(dialog.getByTestId("customize-ai-row-model")).toContainText(
    MODEL,
  );
});

test("saving an untouched Customize tab pins nothing on the agent", async ({
  page,
}) => {
  const dialog = await openCustomizeTab(page);
  await dialog.getByTestId("persona-dialog-submit").click();
  await expect(page.getByTestId("persona-dialog")).toHaveCount(0, {
    timeout: 10_000,
  });

  const payload = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{
          command: string;
          payload: unknown;
        }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return log
      ?.filter((entry) => entry.command === "update_persona")
      .map((entry) => entry.payload as { input?: Record<string, unknown> })
      .at(-1)?.input;
  });

  expect(payload).toBeTruthy();
  expect(payload?.model ?? null).toBeNull();
  expect(payload?.provider ?? null).toBeNull();
  expect(payload?.fallbackModels ?? null).toBeNull();
});
