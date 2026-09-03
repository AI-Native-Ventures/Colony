import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const E2E_IDENTITY_OVERRIDE_STORAGE_KEY =
  "buzz:e2e-identity-override.v1";

export async function seedActiveIdentity(
  page: Page,
  identity: { privateKey: string; pubkey: string; username: string },
) {
  await page.addInitScript(
    ({ identity: nextIdentity, storageKey }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(nextIdentity));
    },
    { identity, storageKey: E2E_IDENTITY_OVERRIDE_STORAGE_KEY },
  );
}

/**
 * Seed the state a brand-new founder reaches the canvas first run with: the
 * fresh-identity marker machine onboarding writes. Must run before
 * installMockBridge, since React reads it on mount and the bridge triggers
 * that mount.
 */
export async function seedFreshFounder(page: Page, pubkey: string) {
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, "true");
    },
    { key: `colony.identity.fresh:${pubkey}` },
  );
}

/**
 * Pass the key-backup step without creating a backup: the primary action
 * opens the consequence acknowledgement, and confirming it finishes
 * onboarding. This is the deliberate no-backup exit, not a quiet skip.
 */
export async function passThroughBackupStep(page: Page) {
  await expect(page.getByTestId("onboarding-page-backup")).toBeVisible();
  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-backup-ack-dialog")).toBeVisible();
  await page.getByTestId("onboarding-backup-ack-confirm").click();
}
