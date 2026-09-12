import { verifyEvent } from "nostr-tools/pure";
import {
  parseScoutOnboardingRoot,
  ROOT_PROTOCOL,
} from "../../src/features/onboarding/channelOnboardingRuntime/protocol";
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
  await page
    .getByLabel("Website", { exact: false })
    .fill("https://horizon.example");
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
    page.getByRole("button", { name: "Test connection" }),
  ).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/simple-founder-power-1440.png" });
  await page.getByRole("button", { name: "Test connection" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
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
  // Signup completion hands the owner context to Scout's choice-first Welcome
  // root. Company writes and agent/work setup wait for the later channel
  // approval, so the root is the durable proof at this stage.
  const retained = await page.evaluate(() => ({
    published: window.__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
    signedProfileUpdates: window.__BUZZ_E2E_COMMAND_PAYLOADS__?.filter(
      (entry) => entry.command === "sign_community_profile_update",
    ),
    commands: window.__BUZZ_E2E_COMMANDS__ ?? [],
  }));
  const roots = retained.published.filter((event) =>
    event.tags.some(
      (tag) => tag[0] === "client" && tag[1] === ROOT_PROTOCOL.marker,
    ),
  );
  expect(roots).toHaveLength(1);
  const root = roots[0];
  expect(root?.kind).toBe(ROOT_PROTOCOL.kind);
  if (!root) throw new Error("Missing signed Scout onboarding root");
  expect(verifyEvent(root)).toBe(true);
  const payload = parseScoutOnboardingRoot(root.tags);
  expect(payload).not.toBeNull();
  if (!payload) throw new Error("The Scout onboarding root was not readable");
  expect(payload).toMatchObject({
    ownerPubkey: TEST_IDENTITIES.tyler.pubkey,
    relayUrl: nativeRelays.active,
    seed: {
      ownerName: "Horizon Owner",
      businessName: "Horizon Labs",
      businessDescription:
        "We build websites and manage social media for small businesses.",
      website: "https://horizon.example",
      websiteState: "provided",
    },
  });
  expect(payload.requestId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
  expect(retained.signedProfileUpdates ?? []).toHaveLength(0);
  for (const command of [
    "attach_thread_task",
    "create_managed_agent",
    "create_team",
    "create_user_task",
    "execute_agent_proposal",
    "publish_note",
    "send_managed_agent_channel_message",
    "send_stream_message",
    "set_canvas",
    "set_thread_canvas",
    "start_managed_agent",
    "start_managed_agent_runtime",
    "update_company_profile",
  ]) {
    expect(retained.commands).not.toContain(command);
  }
});
