import { expect, test, type Page } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  createFounderAccount,
  describeFounderBusiness,
  continueFounderBusiness,
} from "../helpers/onboarding";
import { waitForAnimations } from "../helpers/animations";
import {
  MOCK_SUBSCRIPTION_SCAN,
  MOCK_SUBSCRIPTION_CONNECTIONS,
} from "../../src/testing/e2eBridgeSubscriptions";

async function expectOpaqueFounderSurface(
  page: Page,
  primaryName: string,
  dark = false,
) {
  await page.mouse.move(0, 0);
  const card = page.locator(".onb-simple-card");
  await expect(card).toHaveCSS(
    "background-color",
    dark ? "rgb(41, 39, 43)" : "rgb(255, 255, 255)",
  );
  await expect(card).toHaveCSS("opacity", "1");
  const ancestorOpacity = await card.evaluate((element) => {
    const opacity: string[] = [];
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      opacity.push(getComputedStyle(parent).opacity);
    return opacity;
  });
  expect(ancestorOpacity.every((opacity) => opacity === "1")).toBe(true);
  const fields = card.locator('input:not([type="checkbox"]), textarea');
  for (const field of await fields.all()) {
    await expect(field).toHaveCSS(
      "background-color",
      dark ? "rgb(41, 39, 43)" : "rgb(255, 255, 255)",
    );
    await expect(field).toHaveCSS("opacity", "1");
    if (await field.getAttribute("placeholder")) {
      const placeholder = await field.evaluate(
        (element) => getComputedStyle(element, "::placeholder").color,
      );
      expect(placeholder).toBe(
        dark ? "rgb(180, 174, 166)" : "rgb(100, 98, 96)",
      );
    }
  }
  const primary = page.getByRole("button", { name: primaryName, exact: true });
  await expect(primary).toHaveCSS(
    "background-color",
    (await primary.isDisabled()) ? "rgb(89, 84, 95)" : "rgb(23, 23, 23)",
  );
  await expect(primary).toHaveCSS("opacity", "1");
  await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
  const layers = await page
    .locator(".onb-founder-canvas")
    .evaluate((canvas) => {
      const stage = canvas.querySelector(".onb-simple-card");
      const ants = canvas.querySelector(".onb-founder-ants");
      if (!stage || !ants) return null;
      return {
        stage: Number(getComputedStyle(stage).zIndex),
        ants: Number(getComputedStyle(ants).zIndex),
        decorative: ants.getAttribute("aria-hidden"),
        pointerEvents: getComputedStyle(ants).pointerEvents,
      };
    });
  expect(layers).not.toBeNull();
  expect(layers?.stage).toBeGreaterThan(layers?.ants ?? Infinity);
  expect(layers?.decorative).toBe("true");
  expect(layers?.pointerEvents).toBe("none");
}

async function fresh(
  page: Page,
  settings: Record<string, string> = {},
  mock: Parameters<typeof installMockBridge>[1] = undefined,
) {
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values))
      localStorage.setItem(key, value);
  }, settings);
  await seedActiveIdentity(page, { ...TEST_IDENTITIES.tyler, username: "" });
  await installMockBridge(page, mock, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");
}

async function reachPower(
  page: Page,
  mock: Parameters<typeof installMockBridge>[1] = undefined,
) {
  await fresh(page, {}, mock);
  await createFounderAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await describeFounderBusiness(page);
  await continueFounderBusiness(page);
}

test("power offers all three choices and saves the selected defaults", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await reachPower(page, { subscriptionScan: MOCK_SUBSCRIPTION_SCAN });
  const power = page.getByTestId("onboarding-power");
  await expect(
    power.getByRole("button", { name: /^Colony Credits/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(power.getByLabel(/API Key/)).toHaveCount(0);
  await expect(
    power.getByRole("button", { name: "Open my Colony" }),
  ).toBeEnabled();

  await power.getByRole("button", { name: /^Subscriptions/ }).click();
  await expect(
    power.getByRole("button", { name: /^Claude · Max 20x/ }),
  ).toBeVisible();
  await expect(power).toContainText("Found on this Mac");
  await expect(power).toContainText("65% left");
  await expect(power).not.toContainText(
    "Subscription detection could not finish",
  );
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-subscriptions-1440.png",
  });

  await power.getByRole("button", { name: /^OpenRouter free models/ }).click();
  await expect(page.getByTestId("openrouter-connect-button")).toBeVisible();
  await expect(
    power.getByRole("button", { name: "Open my Colony" }),
  ).toBeDisabled();
  await expect(power).toContainText("50 requests a day");
  await expect(power).toContainText("$10");
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-openrouter-1440.png",
  });

  await power.getByRole("button", { name: /^Colony Credits/ }).click();
  await expect(
    power.getByRole("button", { name: "Open my Colony" }),
  ).toBeEnabled();
  await power.getByRole("button", { name: "Open my Colony" }).click();
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  const saved = await page.evaluate(async () => {
    const config = await window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.(
      "get_global_agent_config",
    );
    return config as {
      credential_mode: string;
      preferred_runtime: string;
      model: string;
      env_vars: Record<string, string>;
    };
  });
  expect(saved.credential_mode).toBe("colony_credits");
  expect(saved.preferred_runtime).toBe("buzz-agent");
  expect(saved.model).toBe("deepseek-v4-flash");
  expect(saved.env_vars.OPENAI_COMPAT_API_KEY).toBeUndefined();
  await expect(page.getByTestId("sidebar-profile-name")).toHaveText(
    "Horizon Owner",
  );
});

test("subscription account retry recovers detection but an unsupported Electron runtime stays blocked", async ({
  page,
}) => {
  const launchError =
    "Claude Code cannot run isolated teammates in this Electron beta. Choose Colony Agent.";
  await reachPower(page, {
    subscriptionConnectionsSequence: [
      { error: "Synthetic subscription scan failed" },
      MOCK_SUBSCRIPTION_CONNECTIONS.map((entry) => ({ ...entry, launchError })),
    ],
    acpRuntimesCatalog: [
      {
        id: "claude",
        label: "Claude Code",
        avatar_url: "",
        availability: "available",
        local_launch_error: launchError,
        command: null,
        binary_path: null,
        default_args: [],
        mcp_command: null,
        install_hint: "Synthetic installed runtime",
        install_instructions_url: "https://example.test/install",
        can_auto_install: false,
        requires_external_cli: true,
        underlying_cli_path: "/synthetic/claude",
        node_required: false,
        auth_status: { status: "logged_in" },
        source: "builtin",
      },
    ],
  });
  const power = page.getByTestId("onboarding-power");
  await power.getByRole("button", { name: /^Subscriptions/ }).click();
  await expect(power).toContainText("We could not check your subscriptions");
  const complete = power.getByRole("button", { name: "Open my Colony" });
  await expect(complete).toBeDisabled();
  await power.getByRole("button", { name: "Check again", exact: true }).click();
  await power.getByRole("button", { name: /^Claude · Max 20x/ }).click();
  await expect(power).toContainText("Found on this Mac");
  await expect(power).not.toContainText(
    "Subscription detection could not finish",
  );
  await expect(
    power.getByRole("button", { name: /^Claude · Max 20x/ }),
  ).toBeVisible();
  await expect(power).toContainText("65% left");
  await expect(power.getByRole("alert")).toContainText(launchError);
  await expect(complete).toBeDisabled();
  expect(
    await page.evaluate(() =>
      window.__BUZZ_E2E_COMMANDS__?.filter(
        (command) => command === "set_global_agent_config",
      ),
    ),
  ).toEqual([]);
});

test("an existing Credits model survives opening the power step and going back", async ({
  page,
}) => {
  await reachPower(page, {
    globalAgentConfig: {
      credential_mode: "colony_credits",
      preferred_runtime: "buzz-agent",
      provider: "openai-compat",
      model: "already-selected-model",
      env_vars: {},
    },
    discoverAgentModels: {
      models: [
        { id: "already-selected-model", name: "Already selected model" },
      ],
      supportsSwitching: true,
    },
  });
  await expect(page.getByLabel("Default model")).toHaveValue(
    "already-selected-model",
  );
  await page.getByRole("button", { name: "Back to business" }).click();
  await expect(page.getByLabel("Business name")).toHaveValue("Horizon Labs");
  await continueFounderBusiness(page);
  await expect(page.getByLabel("Default model")).toHaveValue(
    "already-selected-model",
  );
});

for (const provider of ["anthropic", "openrouter"] as const) {
  test(`existing ${provider} defaults without a runtime pin can complete power unchanged`, async ({
    page,
  }) => {
    const config = {
      credential_mode: "byok" as const,
      preferred_runtime: null,
      provider,
      model: "existing-paid-model",
      env_vars: {
        [provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY"]:
          "synthetic-existing-credential",
      },
    };
    await reachPower(page, {
      globalAgentConfig: config,
      discoverAgentModels: {
        models: [{ id: config.model, name: "Existing paid model" }],
        supportsSwitching: true,
      },
    });
    const power = page.getByTestId("onboarding-power");
    const complete = power.getByRole("button", { name: "Open my Colony" });
    await expect(power).toContainText(
      "Your existing provider settings are preserved",
    );
    await expect(complete).toBeEnabled();
    await power.getByRole("button", { name: "Keep my current setup" }).click();
    await expect(complete).toBeEnabled();
    await page.getByRole("button", { name: "Back to business" }).click();
    await continueFounderBusiness(page);
    await expect(complete).toBeEnabled();
    await complete.click();
    await expect(page.getByTestId("app-top-chrome")).toBeVisible();
    const saved = await page.evaluate(() =>
      window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("get_global_agent_config"),
    );
    expect(saved).toEqual(config);
  });
}

test("Credits failure blocks completion and offers a retry without claiming zero balance", async ({
  page,
}) => {
  await fresh(page);
  await createFounderAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await describeFounderBusiness(page);
  await page.waitForFunction(() => !!window.__BUZZ_E2E_SET_COLONY_CREDITS__);
  await page.evaluate(() =>
    window.__BUZZ_E2E_SET_COLONY_CREDITS__?.({
      error: "Colony Credits gateway is unavailable on this relay",
    }),
  );
  await continueFounderBusiness(page);
  const power = page.getByTestId("onboarding-power");
  await expect(power).toContainText("Colony Credits is unavailable");
  await expect(
    power.getByRole("button", { name: "Open my Colony" }),
  ).toBeDisabled();
  await expect(power).not.toContainText("$0.00 available");
  await page.evaluate(() =>
    window.__BUZZ_E2E_SET_COLONY_CREDITS__?.({ error: null }),
  );
  await power.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(
    power.getByRole("button", { name: "Open my Colony" }),
  ).toBeEnabled();
});

test("recovery cancellation and write failure keep the checkpoint, then saved code continues", async ({
  page,
}) => {
  await fresh(page, { "colony.e2e.recoverySave": "cancel" });
  await createFounderAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert")).toContainText("not saved");
  await expect(page.getByTestId("onboarding-recovery-code")).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem("colony.e2e.recoverySave", "fail"),
  );
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "could not finish saving",
  );
  await page.evaluate(() => localStorage.removeItem("colony.e2e.recoverySave"));
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByTestId("onboarding-business")).toBeVisible();
});

test("recovery reload restores the same synthetic code without putting it in local storage", async ({
  page,
}) => {
  await fresh(page);
  await createFounderAccount(page);
  const code = await page.getByTestId("onboarding-recovery-code").textContent();
  expect(code?.trim()).toBeTruthy();
  expect(
    await page.evaluate(
      (value) =>
        Object.values(localStorage).some((item) =>
          item.includes(value ?? "not-present"),
        ),
      code?.trim(),
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.getByTestId("onboarding-recovery-code")).toHaveText(
    code ?? "",
  );
});

test("a missing website allows manual context and no payment form", async ({
  page,
}) => {
  await fresh(page);
  await createFounderAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await describeFounderBusiness(page);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Do you have a website?")).toHaveCount(0);
  await expect(page.getByText("Is your company up and running?")).toHaveCount(
    0,
  );
});

test("website findings remain editable on the business form", async ({
  page,
}) => {
  await fresh(page);
  await createFounderAccount(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByLabel("Business name").fill("Horizon Labs");
  await page.getByLabel("Website", { exact: false }).fill("horizon.example");
  await page.getByRole("button", { name: "Read website", exact: true }).click();
  const summary = page.getByLabel("Business summary");
  await expect(summary).not.toHaveValue("");
  await summary.fill("Our own corrected business description.");
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await expect(summary).toHaveValue("Our own corrected business description.");
});

test("account and business retain readable opaque forms and brand at narrow width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await fresh(page);
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await expectOpaqueFounderSurface(page, "Create account");
  await page.screenshot({
    path: "test-results/simple-founder-account-360.png",
  });
  await page.getByLabel("Email", { exact: true }).fill("owner@horizon.example");
  await page.getByLabel("Your name", { exact: true }).fill("Horizon Owner");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic strong password");
  await expectOpaqueFounderSurface(page, "Create account");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await waitForAnimations(page);
  await expectOpaqueFounderSurface(page, "Save and continue");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await describeFounderBusiness(page);
  await waitForAnimations(page);
  await expectOpaqueFounderSurface(page, "Continue");
  await page.screenshot({
    path: "test-results/simple-founder-business-360.png",
  });
  const dimensions = await page
    .locator(".onb-simple-card")
    .evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      viewport: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.overflow).toBe(false);
  await page.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await expectOpaqueFounderSurface(page, "Continue", true);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-business-dark-360.png",
  });
  await continueFounderBusiness(page);
  await expect(
    page.getByRole("button", { name: "Open my Colony" }),
  ).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-dark-360.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
});

test("Power buys credits and resumes the same checkout after changing lanes", async ({
  page,
}) => {
  let initialized = 0;
  let paid = false;
  await page.route("**/api/payments/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith("/packs")) {
      body = {
        currency: "USD",
        packs: [
          {
            id: "starter",
            name: "Starter",
            usdCents: 500,
            zarCents: 9900,
            grantNanousd: 5_000_000_000,
          },
        ],
      };
    } else if (path.endsWith("/initialize")) {
      initialized += 1;
      expect(route.request().postDataJSON()).toEqual({
        packId: "starter",
        email: "founder@example.test",
      });
      body = {
        reference: "power-checkout-one",
        authorizationUrl: "https://checkout.example.test/one",
      };
    } else {
      expect(path).toBe("/api/payments/verify");
      expect(route.request().postDataJSON()).toEqual({
        reference: "power-checkout-one",
      });
      body = { paid, usdCents: paid ? 500 : 0 };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await reachPower(page);
  const power = page.getByTestId("onboarding-power");
  await power.getByLabel("Receipt email").fill("founder@example.test");
  await power.getByRole("button", { name: "Pay $5", exact: true }).click();
  await expect(power).toContainText("Your checkout is saved");
  expect(initialized).toBe(1);
  await power.getByRole("button", { name: /^Subscriptions/ }).click();
  await power.getByRole("button", { name: /^Colony Credits/ }).click();
  await expect(
    power.getByRole("button", { name: "Open checkout again" }),
  ).toBeVisible();
  await expect(power.getByRole("button", { name: /^Pay / })).toHaveCount(0);
  await expect(power).not.toContainText("Payment confirmed");
  paid = true;
  await power
    .getByRole("button", { name: "Check payment", exact: true })
    .click();
  await expect(power).toContainText(
    "Payment confirmed. Your credits are available.",
  );
  expect(initialized).toBe(1);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-payment-confirmed.png",
  });
});

test("Power connects OpenRouter, explains verified allowance and rechecks after top-up", async ({
  page,
}) => {
  await reachPower(page, {
    openRouterConnection: {
      status: "connected",
      key: "synthetic-openrouter-key",
    },
    openRouterQuotaSequence: [
      { status: "unpaid" },
      {
        status: "verified",
        quota: {
          total_credits_usd: 10,
          total_usage_usd: 10,
          threshold_met: true,
          requests_per_day: 1000,
          requests_per_minute: 20,
          usd_to_threshold: null,
        },
      },
    ],
  });
  const power = page.getByTestId("onboarding-power");
  await power.getByRole("button", { name: /^OpenRouter free models/ }).click();
  await page.getByTestId("openrouter-connect-button").click();
  const allowance = power.getByTestId("openrouter-allowance");
  await expect(allowance).toContainText("50 free-model requests a day");
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-openrouter-topup.png",
  });
  await allowance
    .getByRole("button", { name: "Add credits on OpenRouter" })
    .click();
  const urls = await page.evaluate(() =>
    window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("get_e2e_opened_external_urls"),
  );
  expect(urls).toContain("https://openrouter.ai/settings/credits");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(allowance).toContainText(
    "Eligible for 1,000 free-model requests a day",
  );
  await expect(
    allowance.getByRole("button", { name: "Add credits on OpenRouter" }),
  ).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-power-openrouter-eligible.png",
  });
});
