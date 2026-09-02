import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const MOCK_OWNER_PUBKEY = "deadbeef".repeat(8);
const RELAY_PUBKEY = "11".repeat(32);
const HUMAN_PUBKEY =
  "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f";
const HUMAN_ASK_ID = "aa".repeat(32);
const DEFAULT_ASK_ID = "bb".repeat(32);
const HUMAN_RESOLUTION_ID = "cc".repeat(32);
const DEFAULT_RESOLUTION_ID = "dd".repeat(32);
const DIR = "test-results/ask-resolution-screenshots";

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
  await page.evaluate(async (mockEvent) => {
    const win = window as Window & {
      __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
        channelName: string;
        event: MockEvent;
      }) => unknown;
      __BUZZ_E2E_QUERY_CLIENT__?: {
        invalidateQueries: (filters: {
          queryKey: readonly unknown[];
        }) => Promise<unknown>;
      };
    };
    win.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
      channelName: "general",
      event: mockEvent,
    });
  }, event);
}

async function invalidateAsks(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const win = window as Window & {
      __BUZZ_E2E_QUERY_CLIENT__?: {
        invalidateQueries: (filters: {
          queryKey: readonly unknown[];
        }) => Promise<unknown>;
      };
    };
    await win.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["open-asks"],
    });
    await win.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["ask-resolutions"],
    });
  });
}

function askEvent(id: string, headline: string): MockEvent {
  return {
    id,
    kind: 44300,
    pubkey: HUMAN_PUBKEY,
    created_at: Math.floor(Date.now() / 1_000) - 3_600,
    content: JSON.stringify({
      type: "decision",
      headline,
      cost_of_delay: "onboarding is blocked",
    }),
    sig: "mocksig".repeat(20).slice(0, 128),
    tags: [["p", MOCK_OWNER_PUBKEY]],
  };
}

test.describe("ask resolution distinction", () => {
  test("an executed default is visibly distinct from a human answer", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("home-inbox")).toBeVisible();

    await emitEvent(page, askEvent(HUMAN_ASK_ID, "Choose the launch vendor"));
    await emitEvent(
      page,
      askEvent(DEFAULT_ASK_ID, "Approve the pricing page copy"),
    );
    await emitEvent(page, {
      id: HUMAN_RESOLUTION_ID,
      kind: 44301,
      pubkey: HUMAN_PUBKEY,
      created_at: Math.floor(Date.now() / 1_000) - 1_800,
      content: JSON.stringify({
        answer: {
          decision: "Use the stable vendor",
          rationale: "Two incidents with the challenger last quarter.",
        },
      }),
      sig: "mocksig".repeat(20).slice(0, 128),
      tags: [["e", HUMAN_ASK_ID]],
    });
    await emitEvent(page, {
      id: DEFAULT_RESOLUTION_ID,
      kind: 44301,
      pubkey: RELAY_PUBKEY,
      created_at: Math.floor(Date.now() / 1_000) - 900,
      content: JSON.stringify({
        answer: { option: "Ship v2 to every customer" },
        default_executed: true,
      }),
      sig: "mocksig".repeat(20).slice(0, 128),
      tags: [["e", DEFAULT_ASK_ID]],
    });
    await invalidateAsks(page);

    // Both closures sit side by side in the Action Center's asks view.
    await page.goto("/#/?view=actions");
    await expect(page.getByTestId("action-center-screen")).toBeVisible();
    await page.getByTestId("action-center-filter-trigger").click();
    await page.getByTestId("action-center-filter-asks").click();

    const humanRow = page.getByTestId(
      `action-center-item-resolved-ask:${HUMAN_ASK_ID}`,
    );
    const defaultRow = page.getByTestId(
      `action-center-item-resolved-ask:${DEFAULT_ASK_ID}`,
    );
    await expect(humanRow).toBeVisible();
    await expect(defaultRow).toBeVisible();
    await expect(defaultRow).toContainText("Default executed");
    await expect(defaultRow).toContainText("Nobody answered");
    await expect(defaultRow).toContainText("Ship v2 to every customer");
    await expect(humanRow).toContainText("Answered");
    await expect(humanRow).toContainText("Use the stable vendor");

    await waitForAnimations(page);
    await page
      .locator("[data-testid='action-center-list']")
      .locator("button")
      .filter({ hasText: "Choose the launch vendor" })
      .screenshot({ path: `${DIR}/01-human-answer-row.png` });
    await page
      .locator("[data-testid='action-center-list']")
      .locator("button")
      .filter({ hasText: "Approve the pricing page copy" })
      .screenshot({ path: `${DIR}/02-executed-default-row.png` });

    // Detail views carry the same distinction.
    await defaultRow.click();
    const defaultDetail = page.getByTestId("action-center-resolved-ask-detail");
    await expect(defaultDetail).toBeVisible();
    await expect(defaultDetail).toContainText("Default executed");
    await expect(defaultDetail).toContainText(
      "Nobody answered before the deadline passed",
    );
    await expect(defaultDetail).toContainText("Ship v2 to every customer");
    await waitForAnimations(page);
    await defaultDetail
      .getByTestId("ask-resolution-notice")
      .screenshot({ path: `${DIR}/03-executed-default-detail.png` });

    await humanRow.click();
    const humanDetail = page.getByTestId("action-center-resolved-ask-detail");
    await expect(humanDetail).toBeVisible();
    await expect(humanDetail).toContainText("Answered");
    await expect(humanDetail).toContainText("Use the stable vendor");
    await waitForAnimations(page);
    await humanDetail
      .getByTestId("ask-resolution-notice")
      .screenshot({ path: `${DIR}/04-human-answer-detail.png` });
  });
});
