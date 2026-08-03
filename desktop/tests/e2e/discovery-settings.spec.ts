import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/discovery-settings";
const PROVIDERS = ["outscraper", "brave_search", "exa_search"] as const;

async function openDiscoverySettings(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await page.getByTestId("settings-nav-discovery").click();
  const card = page.getByTestId("settings-discovery");
  await expect(card).toBeVisible();
  return card;
}

test.describe("Discovery credential settings", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("connects and disconnects without recovering or retaining the key", async ({
    page,
  }) => {
    const consoleMessages: string[] = [];
    page.on("console", (message) => consoleMessages.push(message.text()));
    await installMockBridge(page, {
      discoveryCredentialSaveDelayMs: 150,
      discoveryCredentialStatus: "missing",
    });
    const card = await openDiscoverySettings(page);

    for (const provider of PROVIDERS) {
      await expect(
        card.getByTestId(`discovery-${provider}-credential-status`),
      ).toHaveText("Not connected");
    }
    await expect(card).toContainText("does not upload or synchronize");
    await expect(card).toContainText("billed directly");

    const secrets = PROVIDERS.map(
      (provider) => `test-${provider}-secret-never-rendered-after-save`,
    );
    for (const [index, provider] of PROVIDERS.entries()) {
      const input = card.getByTestId(`discovery-${provider}-key-input`);
      const save = card.getByTestId(`discovery-${provider}-save-credential`);
      await input.fill("   ");
      await expect(save).toBeDisabled();
      await input.fill(secrets[index]);
      await save.click();
      await expect(save).toBeDisabled();
      await save.click({ force: true });

      await expect(
        card.getByTestId(`discovery-${provider}-credential-status`),
      ).toHaveText("Connected");
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute("type", "password");
      await expect(
        card.getByTestId(`discovery-${provider}-credential-confirmation`),
      ).toContainText("connected on this device");
    }
    for (const secret of secrets) await expect(card).not.toContainText(secret);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__BUZZ_E2E_COMMANDS__?.filter(
              (command) => command === "save_discovery_credential",
            ).length ?? 0,
        ),
      )
      .toBe(3);
    const aria = await card.ariaSnapshot();
    const consoleText = consoleMessages.join("\n");
    for (const secret of secrets) {
      expect(aria).not.toContain(secret);
      expect(consoleText).not.toContain(secret);
    }

    await waitForAnimations(page);
    await card.screenshot({ path: `${SHOTS}/01-connected.png` });

    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedCard = await openDiscoverySettings(page);
    for (const [index, provider] of PROVIDERS.entries()) {
      await expect(
        reloadedCard.getByTestId(`discovery-${provider}-credential-status`),
      ).toHaveText("Connected");
      await expect(
        reloadedCard.getByTestId(`discovery-${provider}-key-input`),
      ).toHaveValue("");
      await expect(reloadedCard).not.toContainText(secrets[index]);

      await reloadedCard
        .getByTestId(`discovery-${provider}-delete-credential`)
        .click();
      await expect(
        reloadedCard.getByTestId(`discovery-${provider}-credential-status`),
      ).toHaveText("Not connected");
      await expect(
        reloadedCard.getByTestId(
          `discovery-${provider}-credential-confirmation`,
        ),
      ).toContainText("disconnected from this device");
    }
  });

  test("fails closed when secure storage is unavailable", async ({ page }) => {
    await installMockBridge(page, {
      discoveryCredentialStatus: "unavailable",
    });
    const card = await openDiscoverySettings(page);

    for (const provider of PROVIDERS) {
      await expect(
        card.getByTestId(`discovery-${provider}-credential-status`),
      ).toHaveText("Secure storage unavailable");
      await expect(
        card.getByTestId(`discovery-${provider}-credential-unavailable`),
      ).toContainText("Unlock your system keychain");
      await expect(
        card.getByTestId(`discovery-${provider}-key-input`),
      ).toHaveCount(0);
    }

    await waitForAnimations(page);
    await card.screenshot({
      path: `${SHOTS}/02-secure-storage-unavailable.png`,
    });
  });
});
