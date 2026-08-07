import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const SCREENSHOT_DIR = path.resolve("test-results/discovery-lead-detail");
const SCREENSHOTS = ["discovery-lead-detail-drawer.png"] as const;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

async function capture(locator: Locator, page: Page, filename: string) {
  await expect(locator).toBeVisible();
  await waitForAnimations(page);
  await locator.screenshot({
    animations: "disabled",
    path: path.join(SCREENSHOT_DIR, filename),
  });
}

function assertDistinctScreenshots() {
  const paths = SCREENSHOTS.map((filename) =>
    path.join(SCREENSHOT_DIR, filename),
  );
  expect(
    paths.filter((screenshot) => !existsSync(screenshot)),
    "Every lead detail state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every lead detail state must produce distinct pixels.",
  ).toBe(hashes.length);
  console.log(
    hashes.map((hash, index) => `${SCREENSHOTS[index]} ${hash}`).join("\n"),
  );
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.beforeAll(() => mkdirSync(SCREENSHOT_DIR, { recursive: true }));
test.afterAll(assertDistinctScreenshots);

test("a leadId deep link opens the drawer, survives reload, and closes cleanly", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);

  // The URL is the source of truth: a direct deep link opens the drawer.
  await page.goto(
    "/#/discovery?surface=leads&entity=businesses&leadId=lead-001",
  );
  const drawer = page.getByRole("dialog", { name: /Rosebank Auto Care/ });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Rosebank Auto Care");
  await expect(drawer).toContainText("Rosebank, Johannesburg");
  await expect(drawer).toContainText("Outscraper (Google Maps)");
  await expect(drawer).toContainText("94");
  await expect(drawer).toContainText("Candidate");

  // Reload reopens the drawer from the URL alone.
  await page.reload();
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Rosebank Auto Care");

  // Closing drops leadId and preserves every other search param.
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL(
    /#\/discovery\?(?=.*surface=leads)(?=.*entity=businesses)(?!.*leadId)/,
  );
  expect(errors, "leadId deep link emitted browser errors").toEqual([]);
});

test("clicking a lead row opens the drawer and Escape closes it", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads");
  await expect(page.getByTestId("global-lead-table")).toBeVisible();

  await page.getByTestId("lead-row-lead-002").click();
  const drawer = page.getByRole("dialog", { name: /Soweto Motor Works/ });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Soweto Motor Works");
  await expect(page).toHaveURL(/#\/discovery\?surface=leads&leadId=lead-002$/);
  await capture(drawer, page, "discovery-lead-detail-drawer.png");

  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL(/#\/discovery\?surface=leads$/);
  expect(errors, "row click-through emitted browser errors").toEqual([]);
});

test("a person row opens the same drawer with person fields", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads");
  await page.getByRole("tab", { name: "People" }).click();
  await expect(page.getByTestId("person-row-maya-thompson")).toBeVisible();

  await page.getByTestId("person-row-maya-thompson").click();
  const drawer = page.getByRole("dialog", { name: /Maya Thompson/ });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Maya Thompson");
  await expect(drawer).toContainText("Marketing Director");
  await expect(drawer).toContainText("Northstar Health");
  expect(errors, "person row click-through emitted browser errors").toEqual([]);
});

test("an unknown leadId shows the error state, not an empty drawer", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads&leadId=not-a-real-lead");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Lead unavailable");
  await expect(drawer).not.toContainText("Rosebank Auto Care");

  await drawer.getByTestId("lead-detail-error-close").click();
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL(/#\/discovery\?surface=leads$/);
  expect(errors, "unknown lead emitted browser errors").toEqual([]);
});
