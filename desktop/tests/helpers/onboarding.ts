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

/** Shared public account entry for the approved two-form founder journey. */
export async function createFounderAccount(
  page: Page,
  email = "owner@horizon.example",
) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic strong password");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
}

export async function describeFounderBusiness(
  page: Page,
  name = "Horizon Labs",
) {
  await page.getByLabel("Business name", { exact: true }).fill(name);
  await page
    .getByLabel("What does your business do?", { exact: true })
    .fill("We build websites and manage social media for small businesses.");
}
