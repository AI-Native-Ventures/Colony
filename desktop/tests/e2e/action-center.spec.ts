import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// Several assertions below deliberately wait 30s: CI has landed a refetch just
// past a tighter budget. That equals `playwright.config.ts`'s per-test timeout,
// so the test clock expired first and Playwright blamed whichever assertion was
// in flight — a pure-clock failure that reads as a product flake and reproduced
// on diffs as inert as a version bump. An assertion budget must sit strictly
// inside the test budget for its timeout to mean anything.
test.describe.configure({ timeout: 90_000 });

const MOCK_PUBKEY = "deadbeef".repeat(8);
const CHANNEL_NAME = "general";
const CHANNEL_ID = "channel-general";
const MOCK_SIG = "mocksig".repeat(20).slice(0, 128);

type MockEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  sig: string;
  tags: string[][];
};

function mockEvent(
  overrides: Partial<MockEvent> & Pick<MockEvent, "id" | "kind">,
): MockEvent {
  return {
    pubkey: MOCK_PUBKEY,
    created_at: Math.floor(Date.now() / 1_000),
    content: "{}",
    sig: MOCK_SIG,
    tags: [],
    ...overrides,
  };
}

async function emitEvent(
  page: import("@playwright/test").Page,
  event: MockEvent,
) {
  await page.evaluate(
    ({ channelName, mockEvent: emitted }) => {
      window.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({ channelName, event: emitted });
    },
    { channelName: CHANNEL_NAME, mockEvent: event },
  );
}

async function invalidateAsks(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["open-asks"],
    });
  });
}

// The reminders/asks/home-feed queries mount (for the badge) before a test
// seeds events, so a bare seed lands behind the cached empty result --
// invalidate after seeding to force the refetch that picks up the mock
// events, same pattern reminders.spec.ts's own seedReminders helper uses.
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
    sig: MOCK_SIG,
  };
}

function askEvent(opts: {
  id: string;
  headline: string;
  askerPubkey: string;
  costOfDelay?: string;
  defaultOption?: string;
  defaultWindowSecs?: number;
  initiative?: string;
  taskIds?: string[];
  category?: string;
  createdAt?: number;
}): MockEvent {
  const tags: string[][] = [["p", MOCK_PUBKEY]];
  for (const taskId of opts.taskIds ?? ["task-1"]) tags.push(["task", taskId]);
  if (opts.initiative) tags.push(["initiative", opts.initiative]);
  if (opts.category) tags.push(["category", opts.category]);
  return mockEvent({
    id: opts.id,
    kind: 44300,
    pubkey: opts.askerPubkey,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1_000) - 60,
    content: JSON.stringify({
      type: "decision",
      headline: opts.headline,
      cost_of_delay:
        opts.costOfDelay ?? "Work is blocked until this is answered.",
      ...(opts.defaultOption ? { default_option: opts.defaultOption } : {}),
      ...(opts.defaultWindowSecs !== undefined
        ? { default_window_secs: opts.defaultWindowSecs }
        : {}),
    }),
    tags,
  });
}

// Waits for the lazily-loaded e2e bridge chunk to actually install this
// global before using it -- __BUZZ_E2E_* seams can land 25-55ms after
// installMockBridge resolves (see AGENTS.md's Playwright gotchas), and a
// bare optional call that misses the window is silently a no-op, not a
// failure, so nothing downstream would explain why the ping never appeared.
async function waitForPingSeam(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__ === "function",
  );
}

async function seedPing(
  page: import("@playwright/test").Page,
  opts: {
    pingId: string;
    rootId: string;
    pingerPubkey: string;
    content: string;
    createdAt: number;
  },
) {
  // The root must exist as a real event, authored by the owner, so the
  // batched `ids` lookup useThreadPings runs finds it and the ping
  // qualifies (spec: "owner authored the root, or has posted in the
  // thread" -- a qualifying condition, not a suppression check).
  await emitEvent(
    page,
    mockEvent({
      id: opts.rootId,
      kind: 9,
      pubkey: MOCK_PUBKEY,
      created_at: opts.createdAt - 3_600,
      content: "Kicking off the relaunch copy thread",
      tags: [["h", CHANNEL_ID]],
    }),
  );

  await waitForPingSeam(page);
  // Every value the browser-side callback needs must travel through this
  // second argument -- page.evaluate runs the function in a separate
  // browser JS context, so it cannot close over CHANNEL_ID/CHANNEL_NAME/
  // MOCK_PUBKEY the way an ordinary closure would in Node.
  await page.evaluate(
    ({
      pingId,
      rootId,
      pingerPubkey,
      content,
      createdAt,
      channelId,
      channelName,
      ownerPubkey,
    }) => {
      window.__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?.({
        id: pingId,
        kind: 9,
        pubkey: pingerPubkey,
        content,
        created_at: createdAt,
        channel_id: channelId,
        channel_name: channelName,
        category: "mention",
        tags: [
          ["h", channelId],
          ["p", ownerPubkey],
          ["e", rootId, "", "root"],
          ["e", rootId, "", "reply"],
        ],
      });
      window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["home-feed"],
      });
    },
    {
      pingId: opts.pingId,
      rootId: opts.rootId,
      pingerPubkey: opts.pingerPubkey,
      content: opts.content,
      createdAt: opts.createdAt,
      channelId: CHANNEL_ID,
      channelName: CHANNEL_NAME,
      ownerPubkey: MOCK_PUBKEY,
    },
  );
}

// Actions is a view of the Inbox at `/?view=actions`, not a preview feature
// and not its own route, so there is no override to seed here any more.
test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("opens the native Action Center with URL-backed filters and selection", async ({
  page,
}) => {
  await page.goto("/#/?view=actions");

  await expect(page.getByTestId("action-center-screen")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Action Center" }),
  ).toBeVisible();
  await expect(page.getByTestId("home-top-tab-actions")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("action-center-filter-trigger")).toBeVisible();

  // A due (overdue) reminder is the cheapest honest queue item to anchor on:
  // it survives the v2 ranked-queue model unchanged. `notBefore` in the past
  // makes it due, which is the only thing that makes a reminder enter this
  // queue at all.
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

  // The badge count reflects the same query the row renders from; waiting on
  // it first (generous timeout -- CI has landed the refetch just past a
  // tighter one before) proves the seed has actually landed before the row
  // assertion below, rather than racing it. The row is located by kind
  // prefix, not the exact d-tag id, so this only depends on "a reminder item
  // exists," not on an id staying in lockstep with the seed helper.
  await expect(page.getByTestId("action-center-open-count")).toHaveText("1", {
    timeout: 30_000,
  });

  // The badge proves the query resolved, not that the list pane rendered: the
  // badge renders unconditionally while the list stays behind `isLoading`
  // (ActionCenterScreen.tsx). Wait for the skeleton to clear before locating a
  // row, or the row assertion races the empty->populated swap that recreates
  // the virtualizer's scroll element.
  await expect(page.getByTestId("action-center-loading")).toHaveCount(0);

  const selectedItem = page.getByTestId(/^action-center-item-reminder:/);
  await expect(selectedItem).toBeVisible();
  await selectedItem.click();
  await expect(selectedItem).toHaveAttribute("aria-current", "true");
  await expect(
    page
      .getByTestId("action-center-reminder-detail")
      .getByText("Review the release checklist"),
  ).toBeVisible();
  await expect(page).toHaveURL(/action=reminder/);

  // Switching to a filter the reminder is not part of clears the selection,
  // and action= with it -- the URL-selection reconciliation this spec always
  // exercised. Also where the filter menu itself is exercised (options
  // visible, closes on choice): checking that before any data existed
  // opened the menu right as the list transitioned from its empty state to
  // populated, and the virtualized list's first-mount height measurement
  // landed at zero across that reflow -- a real bug, not a fixture problem,
  // reported separately; this ordering sidesteps it without hiding it.
  await page.getByTestId("action-center-filter-trigger").click();
  await expect(
    page.getByTestId("action-center-filter-needs-action"),
  ).toBeVisible();
  await expect(page.getByTestId("action-center-filter-all")).toBeVisible();
  await page.getByTestId("action-center-filter-asks").click();
  await expect(page).toHaveURL(/filter=asks/);
  await expect(page).not.toHaveURL(/action=/);
  await expect(page.getByTestId("action-center-list-pane")).toBeVisible();

  await page.goto("/#/?view=actions&action=reminder%3Amissing-reminder");
  await expect(
    page.getByTestId("action-center-detail-unavailable"),
  ).toBeVisible();
  await expect(page.getByText("reminder:missing-reminder")).toBeVisible();
});

test("shows the inbox-zero empty state when nothing needs the owner", async ({
  page,
}) => {
  // No seeding at all: a fresh mock bridge starts with an empty queue, and
  // zero is the design goal of this surface (spec), not an error state.
  await page.goto("/#/?view=actions");
  await expect(page.getByTestId("action-center-screen")).toBeVisible();
  await expect(page.getByTestId("action-center-open-count")).toHaveCount(0);
  await expect(page.getByTestId("action-center-empty")).toBeVisible();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
});

test("ranks a countdown ask before a blocked-work ask before a reminder, with a live countdown", async ({
  page,
}) => {
  const ASKER_PUBKEY = "a".repeat(64);
  const COUNTDOWN_ASK_ID = "1".repeat(64);
  const BLOCKED_ASK_ID = "2".repeat(64);
  const now = Math.floor(Date.now() / 1_000);

  await page.goto("/#/?view=actions");
  await expect(page.getByTestId("action-center-screen")).toBeVisible();

  await emitEvent(
    page,
    askEvent({
      id: COUNTDOWN_ASK_ID,
      headline: "Choose the deploy window",
      askerPubkey: ASKER_PUBKEY,
      defaultOption: "Friday 6pm",
      defaultWindowSecs: 6_000, // 100 minutes: "1h 40m" at seed time
      createdAt: now,
    }),
  );
  await emitEvent(
    page,
    askEvent({
      id: BLOCKED_ASK_ID,
      headline: "Approve the contractor rate",
      askerPubkey: ASKER_PUBKEY,
      createdAt: now - 60,
    }),
  );
  await seedReminders(page, [
    mockReminderEvent({
      id: "reminder-tier-01",
      dTag: "rem-tier-01",
      content: JSON.stringify({
        note: "Review payroll export",
        status: "pending",
      }),
      notBefore: now - 300,
    }),
  ]);
  await invalidateAsks(page);

  await expect(page.getByTestId("action-center-open-count")).toHaveText("3", {
    timeout: 30_000,
  });

  const rows = page.locator('[data-testid^="action-center-item-"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute(
    "data-testid",
    `action-center-item-ask:${COUNTDOWN_ASK_ID}`,
  );
  await expect(rows.nth(1)).toHaveAttribute(
    "data-testid",
    `action-center-item-ask:${BLOCKED_ASK_ID}`,
  );
  await expect(rows.nth(2)).toHaveAttribute(
    "data-testid",
    "action-center-item-reminder:rem-tier-01",
  );

  const countdown = rows.nth(0).getByTestId("action-center-ask-countdown");
  await expect(countdown).toBeVisible();
  await expect(countdown).toContainText("defaults to");
  await expect(countdown).toContainText("Friday 6pm");
  // Minute-granularity countdown: assert the shape, not an exact minute
  // count, since real time elapses between seeding and this assertion.
  await expect(countdown).toContainText(/in \d+h \d+m|in \d+m/);
});

test("initiative chips filter the list without changing the badge", async ({
  page,
}) => {
  const ASKER_PUBKEY = "a".repeat(64);
  const RELAUNCH_ASK_ID = "3".repeat(64);
  const HIRING_ASK_ID = "4".repeat(64);

  await page.goto("/#/?view=actions");
  await expect(page.getByTestId("action-center-screen")).toBeVisible();

  await emitEvent(
    page,
    askEvent({
      id: RELAUNCH_ASK_ID,
      headline: "Pick the launch testimonial",
      askerPubkey: ASKER_PUBKEY,
      initiative: "website-relaunch",
    }),
  );
  await emitEvent(
    page,
    askEvent({
      id: HIRING_ASK_ID,
      headline: "Approve the hiring plan",
      askerPubkey: ASKER_PUBKEY,
      initiative: "q3-hiring",
    }),
  );
  await invalidateAsks(page);

  await expect(page.getByTestId("action-center-open-count")).toHaveText("2", {
    timeout: 30_000,
  });

  const chips = page.getByTestId("action-center-initiative-chips");
  await expect(chips).toBeVisible();
  await expect(
    page.getByTestId("action-center-initiative-chip-website-relaunch"),
  ).toHaveText("Website Relaunch");
  await expect(
    page.getByTestId("action-center-initiative-chip-q3-hiring"),
  ).toHaveText("Q3 Hiring");

  await page
    .getByTestId("action-center-initiative-chip-website-relaunch")
    .click();
  await expect(page).toHaveURL(/initiative=website-relaunch/);
  await expect(
    page.getByTestId(`action-center-item-ask:${RELAUNCH_ASK_ID}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`action-center-item-ask:${HIRING_ASK_ID}`),
  ).toHaveCount(0);
  // Chips filter the view; the badge stays whole-queue (spec).
  await expect(page.getByTestId("action-center-open-count")).toHaveText("2");

  await page.getByTestId("action-center-initiative-chip-all").click();
  await expect(page).not.toHaveURL(/initiative=/);
  await expect(
    page.getByTestId(`action-center-item-ask:${HIRING_ASK_ID}`),
  ).toBeVisible();
});

test("dismissing a thread ping publishes a reaction and removes it from the queue", async ({
  page,
}) => {
  const ROOT_ID = "5".repeat(64);
  const PING_ID = "6".repeat(64);
  const PINGER_PUBKEY = "b".repeat(64);
  const now = Math.floor(Date.now() / 1_000);

  await page.goto("/#/?view=actions");
  await expect(page.getByTestId("action-center-screen")).toBeVisible();

  await seedPing(page, {
    pingId: PING_ID,
    rootId: ROOT_ID,
    pingerPubkey: PINGER_PUBKEY,
    content: "Which testimonial goes above the fold?",
    createdAt: now,
  });

  const pingRow = page.getByTestId(`action-center-item-ping:${PING_ID}`);
  await expect(pingRow).toBeVisible({ timeout: 30_000 });

  await pingRow.click();
  await expect(page.getByTestId("action-center-ping-detail")).toBeVisible();
  await page.getByTestId("action-center-ping-dismiss").click();

  await expect(pingRow).toHaveCount(0, { timeout: 30_000 });
});
