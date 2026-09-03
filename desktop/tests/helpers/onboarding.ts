import type { Page } from "@playwright/test";

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
