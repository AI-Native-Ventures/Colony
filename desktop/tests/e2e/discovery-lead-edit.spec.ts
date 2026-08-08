import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const SCREENSHOT_DIR = path.resolve("test-results/discovery-lead-edit");
const SCREENSHOTS = [
  "discovery-lead-edit-form.png",
  "discovery-lead-edit-receipt.png",
] as const;

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

async function openDrawerFromRow(page: Page, rowTestId: string) {
  const row = page.getByTestId(rowTestId);
  await expect(row).toBeVisible();
  // The table is tall enough that the row can sit below the fold; clicking it
  // makes Playwright scroll, which can race the read-model refetch remount
  // right after the drawer closes. Scroll explicitly and click the settled row.
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

function assertDistinctScreenshots() {
  const paths = SCREENSHOTS.map((filename) =>
    path.join(SCREENSHOT_DIR, filename),
  );
  expect(
    paths.filter((screenshot) => !existsSync(screenshot)),
    "Every lead edit state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every lead edit state must produce distinct pixels.",
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

test("edit round trip posts a full profile and the list reflects it", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads");
  await expect(page.getByTestId("global-lead-table")).toBeVisible();

  // Open the drawer from a row, then edit owner, email and notes.
  await openDrawerFromRow(page, "lead-row-lead-001");
  const drawer = page.getByRole("dialog", { name: /Rosebank Auto Care/ });
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("lead-detail-edit").click();
  await drawer.getByTestId("lead-edit-owner").fill("Chief of Staff");
  await drawer
    .getByTestId("lead-edit-email")
    .fill("updated@rosebankautocare.example");
  await drawer.getByTestId("lead-edit-notes").fill("Warm intro");
  await capture(drawer, page, "discovery-lead-edit-form.png");
  await drawer.getByTestId("lead-edit-save").click();

  // The drawer re-renders from the returned receipt.
  await expect(drawer).toContainText("Chief of Staff");
  await expect(drawer).toContainText("Warm intro");
  await expect(drawer).toContainText("updated@rosebankautocare.example");
  await expect(drawer.getByTestId("lead-edit-save")).toBeHidden();

  // The list reflects the new values without a reload.
  await page.getByRole("button", { name: "Close" }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.getByTestId("lead-row-lead-001")).toContainText(
    "updated@rosebankautocare.example",
  );
  // Let the read-model refetch remount settle before re-opening the drawer.
  await page.waitForTimeout(500);

  // A second edit changes only the website; owner, email and notes survive.
  await openDrawerFromRow(page, "lead-row-lead-001");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("lead-detail-edit").click();
  await drawer
    .getByTestId("lead-edit-website")
    .fill("https://rosebank-updated.example");
  await drawer.getByTestId("lead-edit-save").click();

  await expect(drawer).toContainText("https://rosebank-updated.example");
  await expect(drawer).toContainText("Chief of Staff");
  await expect(drawer).toContainText("updated@rosebankautocare.example");
  await expect(drawer).toContainText("Warm intro");
  await capture(drawer, page, "discovery-lead-edit-receipt.png");

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("lead-row-lead-001")).toContainText(
    "updated@rosebankautocare.example",
  );
  expect(errors, "edit round trip emitted browser errors").toEqual([]);
});

test("a relay rejection renders inline and preserves the submitted values", async ({
  page,
}) => {
  const errors = collectErrors(page);

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  // The rejection hook must be installed before the mock bridge mounts the app.
  await page.addInitScript(() => {
    window.__BUZZ_E2E_DISCOVERY_UPDATE_LEAD_REJECT__ = "Invalid field: website";
  });
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads&leadId=lead-001");

  const drawer = page.getByRole("dialog", { name: /Rosebank Auto Care/ });
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("lead-detail-edit").click();
  await drawer.getByTestId("lead-edit-website").fill("not a valid url");
  await drawer.getByTestId("lead-edit-save").click();

  await expect(drawer.getByTestId("lead-edit-error")).toContainText(
    "Invalid field: website",
  );
  await expect(drawer.getByTestId("lead-edit-website")).toHaveValue(
    "not a valid url",
  );

  await drawer.getByTestId("lead-edit-cancel").click();
  await expect(drawer.getByTestId("lead-edit-error")).toBeHidden();
  await expect(drawer).toContainText("https://rosebankautocare.example");
  expect(errors, "rejection round trip emitted browser errors").toEqual([]);
});
