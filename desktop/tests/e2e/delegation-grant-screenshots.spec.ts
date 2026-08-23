import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import type { RelayEvent } from "../../src/shared/api/types";
import { KIND_DELEGATION_GRANT } from "../../src/shared/constants/kinds";

const SHOTS = "test-results/delegation-grant-screenshots";

// The mock relay's membership makes the default mock identity (deadbeef...)
// the community's only owner, so grant heads must carry its pubkey to be
// trusted by the owner-authority scan.
const OWNER_PUBKEY = "deadbeef".repeat(8);

function grantEvent({
  grantId,
  category,
  scope,
  active,
  capNanoUsd,
  createdAt,
}: {
  grantId: string;
  category: string;
  scope: string;
  active: boolean;
  capNanoUsd?: number;
  createdAt: number;
}): RelayEvent {
  const content: Record<string, unknown> = { category, scope, active };
  if (capNanoUsd !== undefined) content.cap_nano_usd = capNanoUsd;
  return {
    id: `mock-grant-${grantId}`.padEnd(64, "0"),
    pubkey: OWNER_PUBKEY,
    created_at: createdAt,
    kind: KIND_DELEGATION_GRANT,
    tags: [["d", grantId]],
    content: JSON.stringify(content),
    sig: "mocksig".repeat(20).slice(0, 128),
  };
}

const SEEDED_GRANTS: RelayEvent[] = [
  grantEvent({
    grantId: "copy-blog-titles",
    category: "copy_change",
    scope: "blog_post_titles",
    active: true,
    capNanoUsd: 25_000_000_000,
    createdAt: 1_800_000_000,
  }),
  grantEvent({
    grantId: "research-summaries",
    category: "research",
    scope: "weekly_digest",
    active: true,
    createdAt: 1_800_000_100,
  }),
  grantEvent({
    grantId: "invoice-vendors",
    category: "bookkeeping",
    scope: "invoice_descriptions",
    active: false,
    capNanoUsd: 10_000_000_000,
    createdAt: 1_799_000_000,
  }),
];

async function openPeopleSection(page: import("@playwright/test").Page) {
  await page.goto("/#/agents?section=people");
  const section = page.getByTestId("people-roles-section");
  await expect(section).toBeVisible();
  return section;
}

test("delegated authority lists active and revoked grants", async ({
  page,
}) => {
  await installMockBridge(page, { delegationGrantEvents: SEEDED_GRANTS });
  await openPeopleSection(page);

  const grantsSection = page.getByTestId("delegated-authority-section");
  await expect(grantsSection).toBeVisible();

  // Two active grants and one revoked record, all from the owner.
  await expect(
    grantsSection.getByTestId("grant-row-copy-blog-titles"),
  ).toBeVisible();
  await expect(
    grantsSection.getByTestId("grant-status-copy-blog-titles"),
  ).toHaveText("Active");
  await expect(
    grantsSection.getByTestId("grant-status-research-summaries"),
  ).toHaveText("Active");
  await expect(
    grantsSection.getByTestId("grant-row-invoice-vendors"),
  ).toBeVisible();
  await expect(
    grantsSection.getByTestId("grant-status-invoice-vendors"),
  ).toHaveText("Revoked");

  await waitForAnimations(page);
  await grantsSection.screenshot({ path: `${SHOTS}/01-grant-list.png` });
});

test("revoking asks for confirmation before publishing", async ({ page }) => {
  await installMockBridge(page, { delegationGrantEvents: SEEDED_GRANTS });
  await openPeopleSection(page);

  const grantsSection = page.getByTestId("delegated-authority-section");
  await grantsSection
    .getByTestId("grant-revoke-copy-blog-titles")
    .scrollIntoViewIfNeeded();

  await grantsSection.getByTestId("grant-revoke-copy-blog-titles").click();

  const confirm = grantsSection.getByTestId(
    "grant-revoke-confirm-copy-blog-titles",
  );
  await expect(confirm).toBeVisible();

  await waitForAnimations(page);
  await grantsSection.screenshot({
    path: `${SHOTS}/02-grant-revoke-confirm.png`,
  });

  // Not revoked until signed.
  await expect(
    grantsSection.getByTestId("grant-row-copy-blog-titles"),
  ).toHaveCount(0);
});

test("the create dialog refuses a hard-list category before signing", async ({
  page,
}) => {
  await installMockBridge(page, { delegationGrantEvents: SEEDED_GRANTS });
  await openPeopleSection(page);

  await page.getByTestId("new-delegation-button").click();
  const dialog = page.getByTestId("delegation-grant-dialog");
  await expect(dialog).toBeVisible();

  await page.getByTestId("new-grant-id-input").fill("spend-refunds");
  await page.getByTestId("new-grant-category-input").fill("spend");
  await page.getByTestId("new-grant-scope-input").fill("refund_emails");

  const problem = page.getByTestId("new-grant-problem");
  await expect(problem).toContainText("hard list");
  await expect(page.getByTestId("new-grant-submit")).toBeDisabled();

  await waitForAnimations(page);
  await dialog.screenshot({ path: `${SHOTS}/03-new-delegation-refusal.png` });
});
