import { expect, test, type Page } from "@playwright/test";
import { deriveWorkspaceAppearance } from "../../src/shared/theme/workspaceAppearance";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

async function openAppearance(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-appearance").click();
  await expect(page.getByTestId("settings-theme")).toBeVisible();
}

async function stops(page: Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["light-top", "light-bottom", "dark-top", "dark-bottom"].map(
      (part) => style.getPropertyValue(`--buzz-gradient-${part}`).trim(),
    );
  });
}

test("existing Appearance page offers Default and Custom, persists colors, and restores Default", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await installMockBridge(page);
  await openAppearance(page);
  const palette = deriveWorkspaceAppearance("#895AF6");
  const initial = [
    palette.light.chromeStart,
    palette.light.chromeEnd,
    palette.dark.chromeStart,
    palette.dark.chromeEnd,
  ];
  await expect.poll(() => stops(page)).toEqual(initial);
  await page.getByTestId("theme-style-trigger").click();
  const choices = page.getByTestId("theme-style-options").getByRole("button");
  await expect(choices).toHaveText(["Default", "Custom"]);
  await expect(page.getByLabel("Color 1", { exact: true })).toHaveCount(0);
  await waitForAnimations(page);
  await page
    .getByTestId("appearance-theme-card")
    .screenshot({ path: "../output/playwright/appearance-default.png" });

  await page.getByTestId("theme-option-custom").click();
  await page.getByLabel("Color 1", { exact: true }).fill("#ff0000");
  await page.getByLabel("Color 2", { exact: true }).fill("#0000ff");
  const custom = ["#ffbdbd", "#bdbdff", "#400000", "#000040"];
  await expect.poll(() => stops(page)).toEqual(custom);
  await expect(page.getByTestId("theme-option-custom")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("appearance-mode-dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => stops(page)).toEqual(custom);
  await page.getByTestId("appearance-mode-system").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect.poll(() => stops(page)).toEqual(custom);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("settings-theme")).toBeVisible();
  await expect(page.getByLabel("Color 1", { exact: true })).toHaveValue(
    "#ff0000",
  );
  await expect(page.getByLabel("Color 2", { exact: true })).toHaveValue(
    "#0000ff",
  );
  await expect.poll(() => stops(page)).toEqual(custom);
  await page.getByTestId("theme-style-trigger").click();
  await page.getByTestId("theme-option-default").click();
  await expect.poll(() => stops(page)).toEqual(initial);
  await expect(page.getByTestId("custom-gradient-controls")).toHaveCount(0);
  await page.getByTestId("theme-option-custom").click();
  await expect(page.getByLabel("Color 1", { exact: true })).toHaveValue(
    "#ff0000",
  );
  // Capture the two-color controls in the existing page with a calmer pair.
  await page.getByLabel("Color 1", { exact: true }).fill("#895af6");
  await page.getByLabel("Color 2", { exact: true }).fill("#5a9cf6");
  await waitForAnimations(page);
  await page
    .getByTestId("appearance-theme-card")
    .screenshot({ path: "../output/playwright/appearance-custom.png" });
  await page.getByTestId("appearance-mode-dark").click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await waitForAnimations(page);
  await page
    .getByTestId("appearance-theme-card")
    .screenshot({ path: "../output/playwright/appearance-custom-dark.png" });
});

test("legacy appearance and malformed custom colors fall back to Default", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "dracula");
    localStorage.setItem(
      "buzz-custom-gradient.v1",
      JSON.stringify({ enabled: true, color1: "red", color2: "#abcdef" }),
    );
  });
  await installMockBridge(page);
  await openAppearance(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await expect(page.getByTestId("theme-style-trigger")).toHaveAttribute(
    "aria-label",
    "Theme style, Default",
  );
  await expect(page.getByTestId("custom-gradient-controls")).toHaveCount(0);
});
