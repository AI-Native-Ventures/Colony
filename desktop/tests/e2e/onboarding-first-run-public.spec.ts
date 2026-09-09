import { waitForAnimations } from "../helpers/animations";
import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  createFounderAccount,
  describeFounderBusiness,
  continueFounderBusiness,
} from "../helpers/onboarding";

/** Real entry routing and renderer with synthetic account/native fixtures. */
test("public first run: account, business and power reach Welcome with the owner's name", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedActiveIdentity(page, { ...TEST_IDENTITIES.tyler, username: "" });
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  const originalDefaultRelay = await page.evaluate(async () => {
    const native = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(command: string): Promise<string> };
      }
    ).__TAURI_INTERNALS__;
    return native.invoke("get_default_relay_url");
  });
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-account-1440.png",
  });
  await createFounderAccount(page);
  await expect(page.getByTestId("onboarding-recovery-code")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-recovery-1440.png",
  });
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Your business" }),
  ).toBeVisible();
  await describeFounderBusiness(page);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-business-1440.png",
  });
  await continueFounderBusiness(page);
  await expect(
    page.getByRole("button", { name: /^Subscriptions/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Colony Credits/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^OpenRouter free models/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open my Colony" }),
  ).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/simple-founder-power-1440.png" });
  await page.getByRole("button", { name: "Open my Colony" }).click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  await expect(page).toHaveURL(/channels/);
  await expect(page.getByTestId("sidebar-profile-name")).toHaveText(
    "Horizon Owner",
  );
  const nativeRelays = await page.evaluate(async () => {
    const native = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke(command: string): Promise<string> };
      }
    ).__TAURI_INTERNALS__;
    const lastApply = window.__BUZZ_E2E_COMMAND_PAYLOADS__?.findLast(
      (entry) => entry.command === "apply_workspace",
    );
    return {
      active: await native.invoke("get_relay_ws_url"),
      default: await native.invoke("get_default_relay_url"),
      builtIn: await native.invoke("get_build_default_relay_url"),
      applied: (lastApply?.payload as { relayUrl?: string } | undefined)
        ?.relayUrl,
    };
  });
  expect(nativeRelays.applied).toBeTruthy();
  expect(nativeRelays.active).toBe(nativeRelays.applied);
  expect(nativeRelays.active).not.toBe(originalDefaultRelay);
  expect(nativeRelays.default).toBe(originalDefaultRelay);
  expect(nativeRelays.builtIn).toBe(originalDefaultRelay);
  await expect(
    page.getByRole("heading", { name: /Pick who|Put something/ }),
  ).toHaveCount(0);
});
