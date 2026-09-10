import { expect, type Page } from "@playwright/test";

/** #general in the mock relay — the project channel a Factory tab needs. */
export const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

/** The persona the launcher offers in a Factory spec. */
export const FACTORY_PERSONAS = [
  {
    id: "custom:avery",
    displayName: "Avery",
    roleId: "engineering-lead",
    roleTitle: "Engineering lead",
    systemPrompt: "Lead the build.",
  },
];

/** Open the channel workspace, whatever surface mode the channel was left in. */
export async function openWorkspace(
  page: Page,
  channelTestId: string,
): Promise<void> {
  const back = page.getByTestId("workspace-back-to-conversation");
  if ((await back.count()) > 0) {
    await back.first().click();
  }
  await page.getByTestId(channelTestId).click();
  const toggle = page.getByTestId("channel-workspace-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("channel-workspace")).toBeVisible();
}

/**
 * Pick an option out of one of the launcher's dropdowns.
 *
 * A searchable dropdown renders its options as a listbox and a plain one as a
 * radio menu, so match either rather than guessing per field.
 */
export async function chooseOption(
  page: Page,
  triggerId: string,
  optionName: string | RegExp,
): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  const option = page
    .getByRole("option", { name: optionName })
    .or(page.getByRole("menuitemradio", { name: optionName }));
  await option.first().click();
  await expect(option).toHaveCount(0);
}

/**
 * Launch one agent into the focused pane of an open Factory canvas and return
 * its pubkey, which is minted at launch and is the id every ask, transcript
 * and tab assertion hangs off.
 */
export async function launchFactoryAgent(
  page: Page,
  brief: string,
): Promise<string> {
  await page.getByTestId("factory-add-agent-btn").click();
  const dialog = page.getByTestId("launch-agent-dialog");
  await expect(dialog).toBeVisible();

  await chooseOption(page, "launch-agent-employee", "Avery · Engineering lead");
  await chooseOption(page, "launch-agent-effort", "high");
  await page.getByTestId("launch-agent-brief-input").fill(brief);
  await page.getByTestId("launch-agent-submit").click();

  // The dialog closes only on a successful launch; an overlay left up would
  // silently swallow every later click.
  await expect(dialog).toHaveCount(0);

  const tile = page.getByTestId("factory-agent-tile");
  await expect(tile).toBeVisible();
  const agentPubkey = await tile.getAttribute("data-agent-pubkey");
  expect(agentPubkey).toMatch(/^[0-9a-f]{64}$/);
  return agentPubkey ?? "";
}
