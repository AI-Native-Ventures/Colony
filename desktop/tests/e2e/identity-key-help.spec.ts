import { expect, type Page, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

async function openExistingIdentity(page: Page) {
  const account = page.getByTestId("onboarding-account");
  await expect(account).toBeVisible();
  const importButton = account.getByRole("button", {
    name: "Import an existing identity",
    exact: true,
  });
  await expect(importButton).not.toBeVisible();
  await account.getByText("More options", { exact: true }).click();
  await importButton.click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
}

test("existing identity options explain how to restore a saved backup", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  await openExistingIdentity(page);
  await expect(
    page.getByText(/Paste your private key to sign in to Colony/),
  ).toBeVisible();
  await expect(page.getByTestId("nostr-import-phone-link")).toBeVisible();
  await page.setViewportSize({ width: 720, height: 620 });
  await page.getByTestId("nostr-import-file-button").click();

  const dialog = page.getByTestId("backup-recovery-dialog");
  await expect(dialog).toBeVisible();
  await waitForAnimations(page);
  await expect(
    dialog.getByRole("heading", { name: "Restore from a backup file" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Choose the encrypted backup file you saved from Colony."),
  ).toBeVisible();
  await expect(dialog).toHaveClass(/shadow-none/);
  const dialogWrapper = dialog.locator("..");
  await expect(dialogWrapper).toHaveCSS("overflow-x", "hidden");
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds?.x).toBeGreaterThanOrEqual(0);
  expect(
    (dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0),
  ).toBeLessThanOrEqual(720);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("nostr-import-nsec-input")).toBeVisible();

  await page.reload();
  await openExistingIdentity(page);
});

test("backup restoration help stays readable when the app resolves dark mode", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  // Fresh profiles follow the system scheme, so the emulated dark scheme is
  // the first-run repro: the app resolves the dark theme while onboarding.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);

  await openExistingIdentity(page);
  await page.getByTestId("nostr-import-file-button").click();

  const dialog = page.getByTestId("backup-recovery-dialog");
  await expect(dialog).toBeVisible();
  await waitForAnimations(page);

  // The textured powder card is baked light in both themes, so the dialog pins
  // the neutral onboarding theme to its light variant. Without the pin the
  // dark theme flips --foreground to near-white and the title disappears
  // against the white card.
  await expect(
    dialog.getByRole("heading", { name: "Restore from a backup file" }),
  ).toHaveCSS("color", "rgb(23, 23, 23)");
});
