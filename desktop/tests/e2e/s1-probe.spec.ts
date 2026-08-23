import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const CATALOG_WITH_CLAUDE = [
  {
    id: "buzz-agent",
    label: "Colony Agent",
    avatar_url: "",
    availability: "available",
    command: "buzz-agent",
    binary_path: "/usr/local/bin/buzz-agent",
    default_args: [],
    mcp_command: "buzz-dev-mcp",
    model_env_var: "BUZZ_AGENT_MODEL",
    provider_env_var: "BUZZ_AGENT_PROVIDER",
    thinking_env_var: null,
    max_tokens_env_var: null,
    context_limit_env_var: null,
    max_rounds_env_var: null,
    install_hint: "",
    install_instructions_url: "",
    can_auto_install: false,
    requires_external_cli: false,
    underlying_cli_path: null,
    node_required: false,
    auth_status: { status: "not_applicable" },
    source: "builtin",
  },
  {
    id: "claude",
    label: "Claude Code",
    avatar_url: "",
    availability: "available",
    command: "claude-agent-acp",
    binary_path: "/usr/local/bin/claude",
    default_args: [],
    mcp_command: null,
    model_env_var: null,
    provider_env_var: null,
    thinking_env_var: null,
    max_tokens_env_var: null,
    context_limit_env_var: null,
    max_rounds_env_var: null,
    install_hint: "",
    install_instructions_url: "",
    can_auto_install: false,
    requires_external_cli: true,
    underlying_cli_path: "/usr/local/bin/claude",
    node_required: false,
    auth_status: { status: "logged_in" },
    source: "preset",
  },
];

test("probe 09 flow with console capture", async ({ page }) => {
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await installMockBridge(page, {
    acpRuntimesCatalog: CATALOG_WITH_CLAUDE as never,
  });
  await page.goto("/");
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("new-agent-card").click();
  await page.locator("#persona-display-name").fill("Test Agent");
  await expect(page.locator("#persona-display-name")).toHaveValue("Test Agent");

  await page.getByRole("tab", { name: "Customize for this agent" }).click();
  await expect(page.locator("#persona-runtime")).toBeVisible({ timeout: 10_000 });
  await page.locator("#persona-runtime").press("Enter");
  await page
    .getByRole("menuitemradio", { name: "Claude Code" })
    .click({ timeout: 5_000 });
  await expect(page.locator("#persona-display-name")).toHaveValue("Test Agent");

  await waitForAnimations(page);
  const tabs = page.getByRole("tab");
  const count = await tabs.count();
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) names.push((await tabs.nth(i).textContent()) ?? "");
  const dialogVisible = await page.getByRole("dialog").isVisible().catch(() => false);
  console.log(
    JSON.stringify(
      { dialogVisible, tabNames: names, pageErrors, consoleLines: consoleLines.slice(-12) },
      null,
      2,
    ),
  );
});
