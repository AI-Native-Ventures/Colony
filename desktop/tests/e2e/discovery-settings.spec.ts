import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/discovery-settings";

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

    await expect(card.getByTestId("discovery-credential-status")).toHaveText(
      "Not connected",
    );
    await expect(card).toContainText("does not upload or synchronize");
    await expect(card).toContainText("billed directly");

    const input = card.getByTestId("discovery-outscraper-key-input");
    const save = card.getByTestId("discovery-save-credential");
    await input.fill("   ");
    await expect(save).toBeDisabled();
    await input.fill("test-secret-never-rendered-after-save");
    await save.click();
    await expect(save).toBeDisabled();
    await save.click({ force: true });

    await expect(card.getByTestId("discovery-credential-status")).toHaveText(
      "Connected",
    );
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("type", "password");
    await expect(card).not.toContainText(
      "test-secret-never-rendered-after-save",
    );
    await expect(
      card.getByTestId("discovery-credential-confirmation"),
    ).toContainText("connected on this device");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__BUZZ_E2E_COMMANDS__?.filter(
              (command) => command === "save_discovery_outscraper_credential",
            ).length ?? 0,
        ),
      )
      .toBe(1);
    expect(await card.ariaSnapshot()).not.toContain(
      "test-secret-never-rendered-after-save",
    );
    expect(consoleMessages.join("\n")).not.toContain(
      "test-secret-never-rendered-after-save",
    );

    await waitForAnimations(page);
    await card.screenshot({ path: `${SHOTS}/01-connected.png` });

    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedCard = await openDiscoverySettings(page);
    await expect(
      reloadedCard.getByTestId("discovery-credential-status"),
    ).toHaveText("Connected");
    await expect(
      reloadedCard.getByTestId("discovery-outscraper-key-input"),
    ).toHaveValue("");
    await expect(reloadedCard).not.toContainText(
      "test-secret-never-rendered-after-save",
    );

    await reloadedCard.getByTestId("discovery-delete-credential").click();
    await expect(
      reloadedCard.getByTestId("discovery-credential-status"),
    ).toHaveText("Not connected");
    await expect(
      reloadedCard.getByTestId("discovery-credential-confirmation"),
    ).toContainText("disconnected from this device");
  });

  test("fails closed when secure storage is unavailable", async ({ page }) => {
    await installMockBridge(page, {
      discoveryCredentialStatus: "unavailable",
    });
    const card = await openDiscoverySettings(page);

    await expect(card.getByTestId("discovery-credential-status")).toHaveText(
      "Secure storage unavailable",
    );
    await expect(
      card.getByTestId("discovery-credential-unavailable"),
    ).toContainText("Unlock your system keychain");
    await expect(
      card.getByTestId("discovery-outscraper-key-input"),
    ).toHaveCount(0);

    await waitForAnimations(page);
    await card.screenshot({
      path: `${SHOTS}/02-secure-storage-unavailable.png`,
    });
  });
});
