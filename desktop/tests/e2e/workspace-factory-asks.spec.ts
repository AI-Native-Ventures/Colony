import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import {
  FACTORY_PERSONAS,
  launchFactoryAgent,
  openWorkspace,
} from "../helpers/factoryAgent";

const SHOTS = "test-results/workspace-factory-asks";

/** The signed-in owner in the mock bridge: who an ask is addressed to. */
const MOCK_OWNER_PUBKEY = "deadbeef".repeat(8);
const MOCK_SIG = "mocksig".repeat(20).slice(0, 128);
const ASK_ID = "ab".repeat(32);

type MockEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  sig: string;
  tags: string[][];
};

type AsksWindow = Window & {
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

/**
 * Seed one open ask raised BY the tile's agent and addressed to the owner.
 *
 * The open-asks query mounts long before this runs (the Inbox badge reads it),
 * so a bare seed lands behind a cached empty result — the invalidate is what
 * forces the refetch that picks the ask up, same as `action-center.spec.ts`.
 */
async function seedAgentAsk(page: Page, agentPubkey: string): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (window as AsksWindow).__BUZZ_E2E_EMIT_MOCK_EVENT__ === "function",
  );
  await page.evaluate(
    async ({ askId, agent, owner, sig }) => {
      const win = window as AsksWindow;
      win.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
        channelName: "general",
        event: {
          id: askId,
          kind: 44300,
          pubkey: agent,
          created_at: Math.floor(Date.now() / 1_000) - 60,
          content: JSON.stringify({
            type: "decision",
            headline: "Force-push the rebased feat/billing-export?",
            cost_of_delay:
              "The export branch stays unmergeable until this is answered.",
            options: [
              {
                label: "Approve",
                consequence: "Rewrites 2 commits nobody else has checked out.",
                recommended: true,
              },
              {
                label: "Deny",
                consequence: "Keeps the merge commits and the noisier history.",
              },
            ],
          }),
          sig,
          tags: [
            ["p", owner],
            ["ask-type", "decision"],
            ["task", "task-1"],
            ["initiative", "no-initiative"],
          ],
        },
      });
      await win.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["open-asks"],
      });
    },
    {
      askId: ASK_ID,
      agent: agentPubkey,
      owner: MOCK_OWNER_PUBKEY,
      sig: MOCK_SIG,
    },
  );
}

test.describe("factory agent asks", () => {
  test("an open ask blocks the tile, and answering it clears the tile", async ({
    page,
  }) => {
    await installMockBridge(page, { personas: FACTORY_PERSONAS });
    await page.goto("/");
    await openWorkspace(page, "channel-general");

    await page.getByTestId("workspace-create-factory").click();
    await expect(page.getByTestId("factory-canvas")).toBeVisible();

    const agentPubkey = await launchFactoryAgent(
      page,
      "Rebase the billing export branch.",
    );
    const tile = page.getByTestId("factory-agent-tile");
    await expect(tile.getByTestId("agent-tile-status")).toHaveText(
      /Working|Idle/,
    );

    await seedAgentAsk(page, agentPubkey);

    // The pill, the card, the tab dot and the toolbar count all say the same
    // thing: this agent is waiting on the owner.
    const pill = tile.getByTestId("agent-tile-status");
    await expect(pill).toHaveAttribute("data-status", "needs-you");
    await expect(pill).toHaveText("Needs you");

    const card = tile.getByTestId("agent-tile-ask");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Avery asks you");
    await expect(
      card.getByRole("heading", {
        name: "Force-push the rebased feat/billing-export?",
      }),
    ).toBeVisible();
    await expect(card.getByTestId("ask-option-Approve")).toBeVisible();
    await expect(card.getByTestId("ask-option-Deny")).toBeVisible();

    await expect(
      page.locator("[data-testid^='factory-tab-ask-dot-']"),
    ).toHaveCount(1);
    await expect(page.locator("[data-ask='true']").first()).toBeVisible();
    await expect(page.getByTestId("factory-needs-you-count")).toHaveText(
      "1 needs you",
    );

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: `${SHOTS}/01-needs-you.png`,
    });

    // Answering with the first option publishes the canonical resolution, and
    // the card leaves on the invalidation rather than on any local state.
    await card.getByTestId("ask-option-Approve").click();
    await card.getByTestId("ask-answer-submit").click();

    await expect(tile.getByTestId("agent-tile-ask")).toHaveCount(0);
    await expect(tile.getByTestId("agent-tile-status")).toHaveText(
      /Working|Idle/,
    );
    await expect(page.getByTestId("factory-needs-you-count")).toHaveCount(0);
    await expect(
      page.locator("[data-testid^='factory-tab-ask-dot-']"),
    ).toHaveCount(0);
  });
});
