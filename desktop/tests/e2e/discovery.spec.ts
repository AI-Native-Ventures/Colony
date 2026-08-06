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
  "discovery-people-fields.png",
  "discovery-people-roles.png",
  "discovery-people-campaign-list.png",
  "discovery-people-campaign-drawer.png",
  "discovery-people-leads.png",
  "discovery-outreach.png",
  "discovery-conversations.png",
  "discovery-access-locked.png",
] as const;

declare global {
  interface Window {
    __BUZZ_E2E_DISCOVERY_EMPTY_LEADS__?: boolean;
  }
}

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
  await expect(page.getByTestId("discovery-top-tab-leads")).toHaveAttribute(
    "data-state",
    "active",
  );
  await page.getByTestId("discovery-top-tab-discover").click();
  await expect(
    page.getByRole("heading", { name: /Millions of leads, one search away/ }),
  ).toBeVisible();
  await expect(page.getByText("All Industries", { exact: true })).toBeVisible();
  await expect(
    page.getByText("New Opportunities", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("34 available", { exact: true })).toBeVisible();
  await expect(page.getByText(/LAKA/i)).toHaveCount(0);
  await capture(appWorkspace(page), page, "discovery-industries.png");

  await page.getByTestId("discovery-industry-card-real-estate").click();
  await expect(
    page.getByRole("heading", { name: "Real Estate" }),
  ).toBeVisible();
  await expect(
    page.getByText("14 Verticals Available", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid^="discovery-vertical-card-"]'),
  ).toHaveCount(14);
  await expect(
    page.getByTestId("discovery-vertical-card-property-development"),
  ).toBeAttached();
  await page.getByText("Back to Industries", { exact: true }).click();

  await page.getByTestId("discovery-industry-card-automotive").click();
  await expect(page.getByRole("heading", { name: "Automotive" })).toBeVisible();
  await expect(
    page.getByText("Back to Industries", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("11 Verticals Available", { exact: true }),
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
  await expect(
    campaignDrawer.getByRole("button", { name: "Create Campaign" }),
  ).toBeEnabled();
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

  await page
    .getByTestId("campaign-tabs")
    .getByRole("tab", { name: /Leads/ })
    .click();
  await expect(page.getByTestId("campaign-lead-table")).toBeVisible();
  await expect(page.getByText("10 companies found")).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-campaign-leads.png");

  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByTestId("discovery-source-list")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Waterfall" })).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-source-config.png");

  const sourceList = page.getByTestId("discovery-source-list");
  const braveHandle = page.getByRole("button", {
    name: "Reorder Brave Web Search",
  });
  await braveHandle.dragTo(
    page.getByRole("button", { name: "Reorder Outscraper (Google Maps)" }),
  );
  await expect(sourceList.locator("[data-source]").first()).toHaveAttribute(
    "data-source",
    "brave_search",
  );

  await page.getByRole("tab", { name: "Concurrent" }).click();
  await expect(page.getByRole("button", { name: /Reorder / })).toHaveCount(0);
  await waitForAnimations(page);
  const exaRow = sourceList.locator('[data-source="exa_search"]');
  const exaSwitch = exaRow.getByRole("switch");
  await expect(exaSwitch).toBeEnabled();
  await exaSwitch.click();
  await expect(exaRow).toHaveAttribute("data-enabled", "false");
  await expect(exaSwitch).toHaveAttribute("data-state", "unchecked");
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("tab", { name: "Concurrent" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(exaRow).toHaveAttribute("data-enabled", "false");

  await page.goto("/#/discovery?surface=leads");
  const globalLeadsHeading = page.getByRole("heading", { name: "Leads." });
  await expect(globalLeadsHeading).toBeVisible();
  const globalLeadsHeadingBox = await globalLeadsHeading.boundingBox();
  expect(
    globalLeadsHeadingBox?.y,
    "The global Leads heading must preserve the Discovery workspace top padding.",
  ).toBeGreaterThan(40);
  await expect(page.getByTestId("global-lead-table")).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-global-leads.png");

  await page.goto("/#/discovery?entity=people&surface=leads");
  await expect(page.getByRole("tab", { name: "People" })).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("global-people-table")).toBeVisible();

  await page.goto("/#/discovery");
  await page.getByTestId("discovery-top-tab-discover").click();
  await page.getByRole("button", { name: "People", exact: true }).click();
  await expect(
    page.getByText(
      "Explore 18 fields and 96 roles to find individual professionals.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("18 available", { exact: true })).toBeVisible();
  await expect(
    page.getByTestId("discovery-field-card-marketing"),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-people-fields.png");

  await page.getByTestId("discovery-field-card-marketing").click();
  await expect(page.getByRole("heading", { name: "Marketing" })).toBeVisible();
  await expect(
    page.getByText("7 Roles Available", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("discovery-role-card-marketing-director"),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-people-roles.png");

  await page.getByTestId("discovery-role-card-marketing-director").click();
  await expect(
    page.getByTestId("discovery-role-campaign-sidebar"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open campaign Marketing Directors — United States",
    }),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-people-campaign-list.png");

  await page.getByTestId("create-people-discovery-campaign").click();
  const peopleCampaignDrawer = page.getByRole("dialog", {
    name: /Tell Jen who to find and how many people you need/,
  });
  await expect(peopleCampaignDrawer).toContainText(
    "What type of professional?",
  );
  await expect(peopleCampaignDrawer).toContainText("How many people?");
  await capture(
    peopleCampaignDrawer,
    page,
    "discovery-people-campaign-drawer.png",
  );
  await peopleCampaignDrawer.getByRole("button", { name: "Cancel" }).click();
  await expect(peopleCampaignDrawer).not.toBeVisible();

  await page
    .getByRole("button", {
      name: "Open campaign Marketing Directors — United States",
    })
    .click();
  await page
    .getByTestId("campaign-tabs")
    .getByRole("tab", { name: /Leads/ })
    .click();
  await expect(page.getByTestId("campaign-people-table")).toBeVisible();
  await expect(page.getByText("8 people found", { exact: true })).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-people-leads.png");

  await page.getByRole("tab", { name: "Outreach" }).click();
  await expect(
    page.getByRole("heading", { name: "Outreach", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "WhatsApp", exact: true }),
  ).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-outreach.png");

  await page.getByRole("tab", { name: "Conversations" }).click();
  await expect(
    page.getByRole("heading", { name: "Conversations", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Reply" })).toBeVisible();
  await capture(appWorkspace(page), page, "discovery-conversations.png");

  // The fixture source is entitled by default, matching the automatic trial.
  // This e2e-only override proves the generic expired-access boundary.
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
    page.getByRole("button", { name: "Discovery access required" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discovery access required" }).click();
  const entitlementDialog = page.getByRole("dialog");
  await expect(entitlementDialog).toContainText("Discovery access required");
  await expect(entitlementDialog).not.toContainText(/LAKA/i);
  await capture(entitlementDialog, page, "discovery-access-locked.png");

  expect(errors, "Discovery parity flow emitted browser errors").toEqual([]);
});

test("Discovery defaults to the Leads tab with an empty state and Discover more", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.addInitScript(() => {
    window.__BUZZ_E2E_DISCOVERY_EMPTY_LEADS__ = true;
  });
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-discovery-view").click();

  await expect(page.getByTestId("discovery-top-tabs")).toBeVisible();
  await expect(page.getByTestId("discovery-top-tab-leads")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("leads-empty-state")).toBeVisible();
  await page.getByTestId("discover-more-button").click();
  await expect(page.getByTestId("discovery-top-tab-discover")).toHaveAttribute(
    "data-state",
    "active",
  );
  expect(errors, "Leads empty-state flow emitted browser errors").toEqual([]);
});
