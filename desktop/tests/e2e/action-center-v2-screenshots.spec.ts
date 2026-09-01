import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

// Screenshots for the v2 queue redesign: a ranked list with a live
// countdown, a hard-list ask with its persistent marker, and the
// inbox-zero empty state. Self-contained per AGENTS.md's screenshot spec
// convention -- seeded data specs do not share helpers across files.

const MOCK_PUBKEY = "deadbeef".repeat(8);
const ASKER_PUBKEY = "a".repeat(64);
const CHANNEL_NAME = "general";
const MOCK_SIG = "mocksig".repeat(20).slice(0, 128);
const DIR = "test-results/action-center-v2-screenshots";

type MockEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  sig: string;
  tags: string[][];
};

async function emitEvent(
  page: import("@playwright/test").Page,
  event: MockEvent,
) {
  await page.evaluate(
    ({ channelName, mockEvent }) => {
      window.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({ channelName, event: mockEvent });
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

function askEvent(opts: {
  id: string;
  headline: string;
  costOfDelay: string;
  defaultOption?: string;
  defaultWindowSecs?: number;
  category?: string;
  taskIds?: string[];
  createdAt?: number;
}): MockEvent {
  const tags: string[][] = [["p", MOCK_PUBKEY]];
  for (const taskId of opts.taskIds ?? ["task-1"]) tags.push(["task", taskId]);
  if (opts.category) tags.push(["category", opts.category]);
  return {
    id: opts.id,
    kind: 44300,
    pubkey: ASKER_PUBKEY,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1_000) - 60,
    content: JSON.stringify({
      type: "decision",
      headline: opts.headline,
      cost_of_delay: opts.costOfDelay,
      ...(opts.defaultOption ? { default_option: opts.defaultOption } : {}),
      ...(opts.defaultWindowSecs !== undefined
        ? { default_window_secs: opts.defaultWindowSecs }
        : {}),
    }),
    sig: MOCK_SIG,
    tags,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ actionCenter: true }),
    );
  });
  await installMockBridge(page);
});

test.describe("action center v2 screenshots", () => {
  test("captures the ranked queue with a countdown, a hard-list ask, and the empty state", async ({
    page,
  }) => {
    const COUNTDOWN_ASK_ID = "1".repeat(64);
    const HARD_LIST_ASK_ID = "2".repeat(64);
    const now = Math.floor(Date.now() / 1_000);

    await page.goto("/#/action-center");
    await expect(page.getByTestId("action-center-screen")).toBeVisible();

    // Empty state first, before anything is seeded.
    await expect(page.getByTestId("action-center-empty")).toBeVisible();
    await waitForAnimations(page);
    await page
      .getByTestId("action-center-empty")
      .screenshot({ path: `${DIR}/01-empty-state.png` });

    await emitEvent(
      page,
      askEvent({
        id: COUNTDOWN_ASK_ID,
        headline: "Choose the deploy window for relaunch",
        costOfDelay:
          "Waiting costs a full week: next safe window is next Friday.",
        defaultOption: "Friday 6pm",
        defaultWindowSecs: 6_000,
        createdAt: now,
      }),
    );
    await emitEvent(
      page,
      askEvent({
        id: HARD_LIST_ASK_ID,
        headline: "Approve contractor rate for landing pages",
        costOfDelay: "3 tasks blocked; agency holds our slot until Thursday.",
        category: "spend",
        taskIds: ["task-1", "task-2", "task-3"],
        createdAt: now - 2 * 86_400,
      }),
    );
    await invalidateAsks(page);

    await expect(page.getByTestId("action-center-open-count")).toHaveText("2", {
      timeout: 30_000,
    });

    const countdownRow = page.getByTestId(
      `action-center-item-ask:${COUNTDOWN_ASK_ID}`,
    );
    const hardListRow = page.getByTestId(
      `action-center-item-ask:${HARD_LIST_ASK_ID}`,
    );
    await expect(countdownRow).toBeVisible();
    await expect(hardListRow).toBeVisible();

    await waitForAnimations(page);
    await page
      .getByTestId("action-center-list-pane")
      .screenshot({ path: `${DIR}/02-ranked-queue-with-countdown.png` });

    await waitForAnimations(page);
    await hardListRow.screenshot({ path: `${DIR}/03-hard-list-ask.png` });
  });
});
