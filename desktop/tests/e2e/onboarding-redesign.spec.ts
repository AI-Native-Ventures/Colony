import { expect, test, type Page } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  seedActiveIdentity,
  createFounderAccount,
  describeFounderBusiness,
} from "../helpers/onboarding";
import { waitForAnimations } from "../helpers/animations";

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

async function fresh(page: Page, settings: Record<string, string> = {}) {
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values))
      localStorage.setItem(key, value);
  }, settings);
  await seedActiveIdentity(page, { ...TEST_IDENTITIES.tyler, username: "" });
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");
}

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
    page.getByRole("button", { name: "Open my Colony" }),
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
    page.getByRole("button", { name: "Open my Colony" }),
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
  await expectOpaqueFounderSurface(page, "Open my Colony");
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
  await expectOpaqueFounderSurface(page, "Open my Colony", true);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/simple-founder-business-dark-360.png",
  });
});
