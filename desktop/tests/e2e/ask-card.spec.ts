import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const MOCK_OWNER_PUBKEY = "deadbeef".repeat(8);
const ASK_ID = "ask-card-e2e";
const SHOT = "test-results/ask-card/ask-card.png";

async function seedOpenAsk(page: import("@playwright/test").Page) {
  await page.evaluate(
    async ({ askId, ownerPubkey }) => {
      const win = window as Window & {
        __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
          channelName: string;
          event: {
            content: string;
            created_at: number;
            id: string;
            kind: number;
            pubkey: string;
            sig: string;
            tags: string[][];
          };
        }) => unknown;
        __BUZZ_E2E_QUERY_CLIENT__?: {
          invalidateQueries: (filters: {
            queryKey: readonly unknown[];
          }) => Promise<unknown>;
        };
      };
      win.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
        channelName: "general",
        event: {
          id: askId,
          pubkey:
            "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
          created_at: Math.floor(Date.now() / 1_000) - 60,
          kind: 44300,
          tags: [["p", ownerPubkey]],
          content: JSON.stringify({
            type: "decision",
            headline: "Choose the launch vendor",
            cost_of_delay: "onboarding is blocked",
          }),
          sig: "mocksig".repeat(20).slice(0, 128),
        },
      });
      await win.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["open-asks"],
      });
    },
    { askId: ASK_ID, ownerPubkey: MOCK_OWNER_PUBKEY },
  );
}

test.describe("ask card", () => {
  test("renders the owner answer card from an open ask", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("home-inbox")).toBeVisible();

    await seedOpenAsk(page);

    const askRow = page.getByTestId(`home-inbox-item-${ASK_ID}`);
    await expect(askRow).toBeVisible();
    await askRow.click();

    const card = page.getByTestId("ask-detail-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Ask · decision")).toBeVisible();
    await expect(
      card.getByRole("heading", { name: "Choose the launch vendor" }),
    ).toBeVisible();
    await expect(
      card.getByText("Waiting costs: onboarding is blocked"),
    ).toBeVisible();
    await expect(card.getByTestId("ask-answer-submit")).toBeDisabled();

    await waitForAnimations(page);
    await page.screenshot({ path: SHOT });

    const decision = card.getByTestId("ask-answer-decision");
    await decision.fill("Use the stable vendor.");
    await expect(card.getByTestId("ask-answer-submit")).toBeEnabled();
  });
});
