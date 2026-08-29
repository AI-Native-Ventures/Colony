import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const MOCK_PUBKEY = "deadbeef".repeat(8);

// The reminders query mounts (for the badge) before a test seeds events, so a
// bare seed lands behind its cached empty result. Invalidate after seeding to
// force the refetch that picks up the mock events — same pattern as
// reminders.spec.ts's own seedReminders helper.
async function seedReminders(
  page: import("@playwright/test").Page,
  events: unknown[],
) {
  await page.evaluate((seeded) => {
    window.__BUZZ_E2E_SEED_MOCK_REMINDERS__?.(
      seeded as Parameters<
        NonNullable<typeof window.__BUZZ_E2E_SEED_MOCK_REMINDERS__>
      >[0],
    );
    window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["reminders"],
    });
  }, events);
}

function mockReminderEvent(opts: {
  id: string;
  dTag: string;
  content: string;
  notBefore: number;
  createdAt?: number;
}) {
  return {
    id: opts.id,
    pubkey: MOCK_PUBKEY,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1_000) - 300,
    kind: 30300,
    tags: [
      ["d", opts.dTag],
      ["not_before", String(opts.notBefore)],
    ],
    content: opts.content,
    sig: "mocksig".repeat(20).slice(0, 128),
  };
}

test.beforeEach(async ({ page }) => {
  // Action Center is an experimental feature (defaultEnabled: false in
  // preview-features.json); addInitScript must run before installMockBridge
  // so the override is in localStorage before React mounts.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ actionCenter: true }),
    );
  });
  await installMockBridge(page);
});

test("opens the native Action Center with URL-backed filters and selection", async ({
  page,
}) => {
  await page.goto("/#/action-center");

  await expect(page.getByTestId("action-center-screen")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Action Center" }),
  ).toBeVisible();
  await expect(page.getByTestId("open-action-center-view")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(page.getByTestId("action-center-filter-trigger")).toBeVisible();
  await page.getByTestId("action-center-filter-trigger").click();
  await expect(
    page.getByTestId("action-center-filter-needs-action"),
  ).toBeVisible();
  await expect(page.getByTestId("action-center-filter-all")).toBeVisible();
  await page.keyboard.press("Escape");

  // A due (overdue) reminder is the cheapest honest queue item to anchor on:
  // it survives the v2 ranked-queue model unchanged, unlike the feed-message
  // and company-task sources this spec used to seed before both were deleted
  // (mentions/activity/company-tasks are no longer Action Center sources —
  // see ranked-queue-model). `notBefore` in the past makes it due, which is
  // the only thing that makes a reminder enter this queue at all.
  const dueTimestamp = Math.floor(Date.now() / 1_000) - 300;
  const reminderContent = JSON.stringify({
    note: "Review the release checklist",
    status: "pending",
  });
  await seedReminders(page, [
    mockReminderEvent({
      id: "reminder-ac-01",
      dTag: "rem-ac-01",
      content: reminderContent,
      notBefore: dueTimestamp,
    }),
  ]);

  const selectedItem = page.getByTestId(
    "action-center-item-reminder:rem-ac-01",
  );
  await expect(selectedItem).toBeVisible();
  await selectedItem.click();
  await expect(selectedItem).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .getByTestId("action-center-reminder-detail")
      .getByText("Review the release checklist"),
  ).toBeVisible();
  await expect(page).toHaveURL(/item=reminder/);

  // Switching to a filter the reminder is not part of clears the selection,
  // and item= with it — the URL-selection reconciliation this spec always
  // exercised, previously via a "Mark done" click that only message items
  // (now deleted) ever offered.
  await page.getByTestId("action-center-filter-trigger").click();
  await page.getByTestId("action-center-filter-asks").click();
  await expect(page).toHaveURL(/filter=asks/);
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.getByTestId("action-center-list-pane")).toBeVisible();

  await page.goto("/#/action-center?item=reminder%3Amissing-reminder");
  await expect(
    page.getByTestId("action-center-detail-unavailable"),
  ).toBeVisible();
  await expect(page.getByText("reminder:missing-reminder")).toBeVisible();
});
