import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const SCREENSHOT_DIR = path.resolve("test-results/discovery-parity");
const SCREENSHOTS = [
  "discovery-industries.png",
  "discovery-verticals.png",
  "discovery-campaign-list.png",
  "discovery-campaign-drawer.png",
  "discovery-overview.png",
  "discovery-progress.png",
  "discovery-campaign-leads.png",
  "discovery-global-leads.png",
  "discovery-source-config.png",
  "discovery-laka-locked.png",
] as const;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

async function capture(locator: Locator, page: Page, filename: string) {
  await expect(locator).toBeVisible();
  await locator.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
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
    "Every Discovery parity state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every Discovery parity state must produce distinct pixels.",
  ).toBe(hashes.length);
  console.log(
    hashes.map((hash, index) => `${SCREENSHOTS[index]} ${hash}`).join("\n"),
  );
}

function appWorkspace(page: Page) {
  // Capture the Buzz shell as well as the Discovery surface. The source
  // reference is a sidebar-mounted experience, so clipping to the inner
  // workspace would hide the very composition we are validating.
  return page.locator("body");
}

test.beforeAll(() => mkdirSync(SCREENSHOT_DIR, { recursive: true }));
test.afterAll(assertDistinctScreenshots);

test("Discovery mirrors the SalesTeams discovery-to-leads journey", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/");

  await page.getByTestId("open-discovery-view").click();
  await expect(page).toHaveURL(/#\/discovery/);
  await expect(page.getByTestId("open-discovery-view")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Millions of leads, one search away/ }),
  ).toBeVisible();
  await expect(page.getByText("All Industries", { exact: true })).toBeVisible();
  await expect(
    page.getByText("New Opportunities", { exact: true }),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-industries.png");

  await page.getByTestId("discovery-industry-card-automotive").click();
  await expect(page.getByRole("heading", { name: "Automotive" })).toBeVisible();
  await expect(
    page.getByText("Back to Industries", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("3 Verticals Available", { exact: true }),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-verticals.png");

  await page.getByTestId("discovery-vertical-card-auto-repair").click();
  await expect(page.getByTestId("discovery-campaign-sidebar")).toBeVisible();
  await expect(page.getByText("Campaigns", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New Campaign" }),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-campaign-list.png");

  await page.getByRole("button", { name: "New Campaign" }).click();
  const campaignDrawer = page.getByRole("dialog", {
    name: /Tell Jen where to find leads/,
  });
  await expect(campaignDrawer).toBeVisible();
  await expect(campaignDrawer).toContainText(
    "Tell Jen where to find leads and how many you need.",
  );
  await expect(
    campaignDrawer.getByText("Advanced: Data Sources", { exact: true }),
  ).toBeVisible();
  await expect(
    campaignDrawer.getByText("Advanced Criteria", { exact: true }),
  ).toBeVisible();
  await capture(campaignDrawer, page, "discovery-campaign-drawer.png");
  await campaignDrawer.getByRole("button", { name: "Cancel" }).click();
  await expect(campaignDrawer).not.toBeVisible();

  await page.getByRole("button", { name: /Open campaign Auto Repair/ }).click();
  await expect(
    page.getByRole("heading", { name: "Auto Repair — Johannesburg" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await capture(appWorkspace(page), page, "discovery-overview.png");

  await page.getByRole("tab", { name: "Discovery" }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to discover" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start Discovery" }).click();
  await expect(
    page.getByRole("heading", { name: "Discovery complete" }),
  ).toBeVisible({
    timeout: 10_000,
  });
  await capture(appWorkspace(page), page, "discovery-progress.png");

  await page.getByRole("tab", { name: /Leads/ }).click();
  await expect(page.getByTestId("campaign-lead-table")).toBeVisible();
  await expect(page.getByText("10 companies found")).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-campaign-leads.png");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("discovery-source-list")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Waterfall" })).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-source-config.png");

  await page.goto("/#/discovery?surface=leads");
  await expect(page.getByRole("heading", { name: "Leads." })).toBeVisible();
  await expect(page.getByTestId("global-lead-table")).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-global-leads.png");

  // The fixture source is entitled by default. The e2e-only init hook below
  // exercises the same persisted campaign route with the LAKA lock visible.
  await page.addInitScript(() => {
    (
      window as Window & { __BUZZ_E2E_DISCOVERY_ENTITLEMENT__?: string }
    ).__BUZZ_E2E_DISCOVERY_ENTITLEMENT__ = "not_entitled";
  });
  await page.goto(
    "/#/discovery?surface=campaign&industryId=automotive&verticalId=auto-repair&campaignId=auto-repair-johannesburg&tab=overview",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Unlock with LAKA" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unlock with LAKA" }).click();
  const entitlementDialog = page.getByRole("dialog");
  await expect(entitlementDialog).toContainText("Discovery is part of LAKA");
  await capture(entitlementDialog, page, "discovery-laka-locked.png");

  expect(errors, "Discovery parity flow emitted browser errors").toEqual([]);
});
