// Helpers for driving the packaged app via the embedded WebDriver session.
import { browser, expect } from "@wdio/globals";

import { RELAY_WS_URL } from "./env";

export type IdentityInfo = {
  pubkey: string;
  display_name: string;
  lost: boolean;
  locked: boolean;
  reset_failed: boolean;
};

export function getIdentity(): Promise<IdentityInfo> {
  return browser.tauri.execute((tauri) =>
    tauri.core.invoke("get_identity"),
  ) as unknown as Promise<IdentityInfo>;
}

export function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return browser.tauri.execute(
    (tauri, c, a) => tauri.core.invoke(c, a),
    command,
    args,
  ) as Promise<T>;
}

export function isPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

// Wait until React has committed something into #root (first paint).
export async function waitForFirstPaint(timeoutMs = 240_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const children = await browser.execute(
        () => document.querySelector("#root")?.children.length ?? 0,
      );
      return children > 0;
    },
    { timeout: timeoutMs, timeoutMsg: "app never reached first paint" },
  );
}

// The window the app creates must be real: visible geometry, not 0x0.
export async function expectRealWindow(): Promise<void> {
  const rect = await browser.getWindowRect();
  expect(rect.width).toBeGreaterThan(400);
  expect(rect.height).toBeGreaterThan(300);
}

export async function waitForTestId(
  testId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const el = await $(`[data-testid="${testId}"]`);
  await el.waitForDisplayed({ timeout: timeoutMs });
}

export async function clickTestId(
  testId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const el = await $(`[data-testid="${testId}"]`);
  await el.waitForDisplayed({ timeout: timeoutMs });
  await el.click();
}

export async function fillTestId(
  testId: string,
  value: string,
  timeoutMs = 60_000,
): Promise<void> {
  const el = await $(`[data-testid="${testId}"]`);
  await el.waitForDisplayed({ timeout: timeoutMs });
  await el.setValue(value);
}

export const relayUrl = RELAY_WS_URL;

// The welcome/join entry after machine onboarding completes.
export async function joinCommunityViaUi(displayName: string): Promise<void> {
  await clickTestId("community-choice-join");
  await fillTestId("invite-redeem-input", RELAY_WS_URL);
  await clickTestId("invite-redeem-submit");
  // Community onboarding profile stage (fresh join): name, next, team intro.
  await waitForTestId("community-profile-name-key", 120_000);
  await fillTestId("community-profile-name-key", displayName);
  await clickTestId("community-profile-next");
  await waitForTestId("community-team-intro-enter", 120_000);
  await clickTestId("community-team-intro-enter");
}
