import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

const SHOT_DIR = "test-results/onboarding-docked-cta";
const NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";

test.use({ viewport: { width: 1280, height: 800 } });

test("machine onboarding: simple entry and account recovery", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01-landing.png` });

  await expect(
    page.getByRole("button", { name: "Start with Colony" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to an existing account" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign in to an existing account" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  const importCard = page.getByTestId("nostr-import-card");
  await expect(importCard).toBeVisible();
  await expect(page.getByLabel("Private key", { exact: true })).toBeVisible();
  // The production card uses a baked nine-slice texture: no runtime SVG
  // filter, measurement, or texture regeneration during resize.
  await expect(importCard).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(importCard).toHaveCSS("border-top-width", "0px");
  await expect(importCard).toHaveCSS("border-image-repeat", "repeat");
  await expect(importCard).toHaveCSS("border-image-outset", "96px");
  // Icon SVGs (e.g. the reveal toggle) are fine; a filter would mean the
  // texture regressed to the runtime SVG pipeline.
  await expect(importCard.locator("svg filter")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01b-enter-key.png` });

  await page.getByTestId("nostr-import-nsec-input").fill(NCRYPTSEC);
  await expect(
    page.getByRole("heading", { name: "Unlock your account" }),
  ).toBeVisible();
  await expect(page.getByTestId("backup-password-timeline")).toBeVisible();
  await expect(page.getByTestId("restore-ncryptsec-affordance")).toBeVisible();
  await expect(page.getByTestId("restore-unlock-icon")).toBeVisible();
  await expect(page.getByTestId("nostr-import-passphrase")).toBeFocused();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01c-restore-backup.png` });

  // The first Back returns to key entry; the second returns to simple entry.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importCard).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start with Colony" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start with Colony" }).click();
  await expect(
    page.getByRole("heading", { name: "Join or create a community" }),
  ).toBeVisible();
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-backup")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02-community-choice.png` });
});

test("machine key import remains usable in a short viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Sign in to an existing account" })
    .click();

  const heading = page.getByRole("heading", { name: "Enter your private key" });
  const input = page.getByLabel("Private key", { exact: true });
  const footer = page.getByTestId("onboarding-footer-slot");
  await expect(heading).toBeVisible();
  await expect(input).toBeVisible();
  await expect(footer).toBeVisible();

  const layout = await page.evaluate(() => {
    const heading = document.querySelector("h1")?.getBoundingClientRect();
    const input = document
      .querySelector<HTMLInputElement>("#nostr-private-key")
      ?.getBoundingClientRect();
    const footer = document
      .querySelector('[data-testid="onboarding-footer-slot"]')
      ?.getBoundingClientRect();
    return {
      footerTop: footer?.top ?? 0,
      headingBottom: heading?.bottom ?? 0,
      inputBottom: input?.bottom ?? 0,
      inputTop: input?.top ?? 0,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.inputTop).toBeGreaterThan(layout.headingBottom);
  expect(layout.footerTop).toBeGreaterThan(layout.inputBottom);
  expect(layout.scrollHeight).toBeGreaterThanOrEqual(620);
  expect(layout.scrollWidth).toBe(layout.clientWidth);
});

test("simple account entry keeps one-column geometry on narrow windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  const actions = page
    .getByTestId("machine-onboarding-gate")
    .getByRole("button")
    .filter({ hasText: /Start with Colony|Sign in to an existing account/ });
  await expect(actions).toHaveCount(2);
  await waitForAnimations(page);
  const geometry = await actions.evaluateAll((elements) => {
    const first = elements[0];
    const second = elements[1];
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) {
      throw new Error("Expected both onboarding actions to be rendered");
    }
    const firstBox = first.getBoundingClientRect();
    const secondBox = second.getBoundingClientRect();
    return {
      clientWidth: document.documentElement.clientWidth,
      firstBottom: firstBox.bottom,
      firstCenter: firstBox.left + firstBox.width / 2,
      lefts: elements.map((element) => element.getBoundingClientRect().left),
      rights: elements.map((element) => element.getBoundingClientRect().right),
      scrollWidth: document.documentElement.scrollWidth,
      secondCenter: secondBox.left + secondBox.width / 2,
      secondTop: secondBox.top,
    };
  });
  expect(Math.abs(geometry.firstCenter - geometry.secondCenter)).toBeLessThan(
    1,
  );
  expect(geometry.secondTop).toBeGreaterThan(geometry.firstBottom);
  expect(geometry.lefts.every((left) => left >= 0)).toBe(true);
  expect(geometry.rights.every((right) => right <= geometry.clientWidth)).toBe(
    true,
  );
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
});

test("relay onboarding: profile and avatar docked CTAs", async ({ page }) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-page-1")).toBeVisible();
  await page.getByTestId("onboarding-display-name").fill("Ada Lovelace");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/04-profile.png` });

  await page.getByTestId("onboarding-next").click();
  await expect(page.getByTestId("onboarding-page-avatar")).toBeVisible();
  await page
    .getByTestId("onboarding-avatar-url")
    .fill("https://example.com/onboarding-avatar.png");
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/05-avatar.png` });
});
