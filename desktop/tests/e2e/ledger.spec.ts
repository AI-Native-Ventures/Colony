import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

/**
 * The Spend screen, against a seeded ledger report.
 *
 * The fixture carries money as decimal strings, exactly as the Tauri command
 * emits it, and one amount is deliberately past `Number.MAX_SAFE_INTEGER`
 * (2^53 nanoUSD is about $9,007, which a real company passes inside a year).
 * A screen that parsed money as a JavaScript number would render a rounded
 * figure here and the assertion would catch it.
 */

const OUTPUT_DIR = "test-results/ledger";

/** $12,345.67 — comfortably past the exact-integer range for a double. */
const LARGE_METERED = "12345670000000";
/** $980.00 */
const IMPUTED = "980000000000";
/** $9,000.00 attributed, $3,345.67 not. */
const COGS = "9000000000000";
const NEEDS_REVIEW = "3345670000000";

const REPORT = {
  budgetStatus: [
    {
      actualNanousd: "9000000000000",
      budgetNanousd: "8000000000000",
      costCentreId: "web-delivery",
      period: "2026-08",
    },
    {
      actualNanousd: "340000000000",
      budgetNanousd: "2000000000000",
      costCentreId: "internal-ops",
      period: "2026-08",
    },
  ],
  byCostCentre: [
    { amountNanousd: NEEDS_REVIEW, costCentreId: "needs-review" },
    { amountNanousd: "9000000000000", costCentreId: "web-delivery" },
    { amountNanousd: "340000000000", costCentreId: "internal-ops" },
  ],
  byDay: [
    {
      day: "2026-08-03",
      meteredNanousd: LARGE_METERED,
      provider: "anthropic",
    },
  ],
  entries: [
    {
      attributedBy: { id: "r1", kind: "rule" },
      costNanousd: "9000000000000",
      day: "2026-08-02",
      effectiveAssignment: {
        clientOrganizationId: "tennant-group",
        commercialPurpose: "clientDelivery",
        companyId: "horizon-labs",
        costCentreId: "web-delivery",
        owningTeamId: "web-team",
        taskId: null,
      },
      effectiveClassification: "cogs",
      eventId: "a".repeat(64),
      model: "claude-sonnet-4-5",
      originalClassification: "cogs",
      paymentMode: "metered",
      provider: "anthropic",
    },
    {
      attributedBy: { kind: "needsReview" },
      costNanousd: null,
      day: "2026-08-03",
      effectiveAssignment: null,
      effectiveClassification: "needsReview",
      eventId: "b".repeat(64),
      model: "gpt-5.6-sol",
      originalClassification: "needsReview",
      paymentMode: "metered",
      provider: "openai",
    },
    {
      attributedBy: { kind: "explicit" },
      costNanousd: IMPUTED,
      day: "2026-08-03",
      effectiveAssignment: {
        clientOrganizationId: null,
        commercialPurpose: "internalProduct",
        companyId: "horizon-labs",
        costCentreId: "internal-ops",
        owningTeamId: "platform",
        taskId: null,
      },
      effectiveClassification: "opex",
      eventId: "c".repeat(64),
      model: "claude-opus-5",
      originalClassification: "opex",
      paymentMode: "imputed",
      provider: "anthropic",
    },
  ],
  exceptions: [
    {
      diagnosis: null,
      exception: {
        eventId: "b".repeat(64),
        model: "gpt-5.6-sol",
        type: "unpricedModel",
      },
    },
  ],
  imputedNanousd: IMPUTED,
  meteredNanousd: LARGE_METERED,
  priceBookMissing: false,
  totals: { cogs: COGS, needsReview: NEEDS_REVIEW, opex: "340000000000" },
  unreadableRecords: 0,
};

test.describe("Spend", () => {
  test("shows what the company spent, exactly", async ({ page }) => {
    await seedActiveIdentity(page);
    await installMockBridge(page, { ledgerReport: REPORT });
    await page.goto("/");

    await page.getByTestId("open-spend-view").click();
    const spendPage = page.getByTestId("ledger-page");
    await expect(spendPage).toBeVisible();

    // Money past 2^53 nanoUSD renders exactly. A number-based parse would
    // land a cent or more away from this.
    const totals = page.getByTestId("ledger-totals");
    await expect(totals).toContainText("$12,345.67");
    await expect(totals).toContainText("$980.00");

    // An unpriced model blocks, and says so above the totals rather than
    // below them.
    const attention = page.getByTestId("ledger-attention");
    await expect(attention).toContainText("gpt-5.6-sol");
    await expect(attention.getByRole("alert").first()).toBeVisible();

    // Over-budget is visible as a number, not only as a colour.
    await expect(page.getByTestId("ledger-budgets")).toContainText("113%");

    // An unpriced call reads as "not priced", never as $0.00, which would
    // claim the call was free.
    const activity = page.getByTestId("ledger-activity");
    await expect(activity).toContainText("not priced");

    await waitForAnimations(page);
    await page.screenshot({
      path: `${OUTPUT_DIR}/01-spend-overview.png`,
    });

    // The page scrolls inside its own container, so a full-page screenshot
    // still only captures the viewport. Scroll to reach the breakdown and
    // activity sections.
    await spendPage.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await waitForAnimations(page);
    await page.screenshot({
      path: `${OUTPUT_DIR}/02-spend-breakdown.png`,
    });
  });

  test("says plainly when nothing has been spent", async ({ page }) => {
    await seedActiveIdentity(page);
    await installMockBridge(page);
    await page.goto("/");

    await page.getByTestId("open-spend-view").click();
    await expect(page.getByTestId("ledger-page")).toBeVisible();
    await expect(page.getByText("No agent spend recorded yet")).toBeVisible();

    await waitForAnimations(page);
    await page.screenshot({
      path: `${OUTPUT_DIR}/03-spend-empty.png`,
    });
  });
});
