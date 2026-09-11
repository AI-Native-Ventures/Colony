import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import {
  chooseOption,
  FACTORY_PERSONAS as PERSONAS,
  GENERAL_CHANNEL_ID,
  openWorkspace,
} from "../helpers/factoryAgent";

const SHOTS = "test-results/workspace-factory-agent";

type PublishedEvent = { id: string; content: string; tags: string[][] };

type FactoryAgentWindow = Window & {
  __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
  __BUZZ_E2E_SEED_OBSERVER_EVENTS__?: (input: {
    agentPubkey: string;
    events: Array<{
      seq: number;
      timestamp: string;
      kind: string;
      agentIndex: number | null;
      channelId: string | null;
      sessionId: string | null;
      turnId: string | null;
      payload: unknown;
    }>;
  }) => void;
};

async function publishedEvents(page: Page): Promise<PublishedEvent[]> {
  return await page.evaluate(
    () => (window as FactoryAgentWindow).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
  );
}

test.describe("factory agent tile", () => {
  test("launches an agent into a pane, posts the brief, and replies in its thread", async ({
    page,
  }) => {
    await installMockBridge(page, { personas: PERSONAS });
    await page.goto("/");
    await openWorkspace(page, "channel-general");

    await page.getByTestId("workspace-create-factory").click();
    await expect(page.getByTestId("factory-canvas")).toBeVisible();

    // The launcher.
    await page.getByTestId("factory-add-agent-btn").click();
    const dialog = page.getByTestId("launch-agent-dialog");
    await expect(dialog).toBeVisible();

    await chooseOption(
      page,
      "launch-agent-employee",
      "Avery · Engineering lead",
    );
    await chooseOption(page, "launch-agent-effort", "high");
    await page
      .getByTestId("launch-agent-brief-input")
      .fill("Add CSV export to the ledger.");
    await page.getByTestId("launch-agent-submit").click();

    // The dialog closes only on a successful launch; an overlay left up would
    // silently swallow every later click.
    await expect(dialog).toHaveCount(0);

    // The tile is the focused pane's visible tab, inside the canvas.
    await expect(page.getByTestId("factory-canvas")).toBeVisible();
    const tile = page.getByTestId("factory-agent-tile");
    await expect(tile).toBeVisible();
    await expect(tile.getByTestId("agent-tile-name")).toHaveText("Avery");
    await expect(tile.getByTestId("agent-tile-harness-chip")).toBeVisible();
    await expect(tile.getByTestId("agent-tile-status")).toHaveText(
      /Working|Idle/,
    );
    // The model chip is the shared ModelPicker; a freshly minted agent has no
    // pinned model, so it reads Auto.
    await expect(
      tile.getByRole("button", { name: /Auto|claude|gpt/ }),
    ).toBeVisible();
    await expect(page.getByTestId("factory-agent-count")).toHaveText(
      /1 agent · \d working/,
    );

    const agentPubkey = await tile.getAttribute("data-agent-pubkey");
    expect(agentPubkey).toMatch(/^[0-9a-f]{64}$/);

    // The brief landed in #general as a message mentioning the agent.
    const brief = (await publishedEvents(page)).find(
      (event) => event.content === "Add CSV export to the ledger.",
    );
    expect(brief).toBeTruthy();
    expect(
      brief?.tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey),
    ).toBe(true);
    // A thread root has no parent of its own: no reply `e` tag, only the
    // channel's own `h` scoping.
    expect(brief?.tags.some((tag) => tag[0] === "e")).toBe(false);
    expect(
      brief?.tags.some(
        (tag) => tag[0] === "h" && tag[1] === GENERAL_CHANNEL_ID,
      ),
    ).toBe(true);

    // Transcript: empty until the observer says otherwise, then the frame.
    await expect(tile.getByText(/Message Avery to start a turn/)).toBeVisible();
    await page.evaluate(
      ({ pubkey, channelId }) => {
        (window as FactoryAgentWindow).__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
          agentPubkey: pubkey as string,
          events: [
            {
              seq: 1,
              timestamp: new Date().toISOString(),
              kind: "acp_read",
              agentIndex: 0,
              channelId,
              sessionId: "session-001",
              turnId: "turn-001",
              payload: {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: "session-001",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: "Reading the ledger table first.",
                    },
                  },
                },
              },
            },
          ],
        });
      },
      { pubkey: agentPubkey, channelId: GENERAL_CHANNEL_ID },
    );
    await expect(
      tile.getByText("Reading the ledger table first."),
    ).toBeVisible();

    // The composer replies into the thread the brief rooted.
    await page
      .getByTestId("agent-tile-composer-input")
      .fill("Totals must follow the active filters.");
    await page.getByTestId("agent-tile-composer-send").click();
    await expect
      .poll(async () =>
        (await publishedEvents(page)).some(
          (event) =>
            event.content === "Totals must follow the active filters." &&
            event.tags.some(
              (tag) => tag[0] === "e" && tag[1] === brief?.id && tag[3] !== "",
            ),
        ),
      )
      .toBe(true);
    const reply = (await publishedEvents(page)).find(
      (event) => event.content === "Totals must follow the active filters.",
    );
    // Reply, not a second root: it e-tags the brief and p-tags the agent.
    expect(
      reply?.tags.some((tag) => tag[0] === "e" && tag[1] === brief?.id),
    ).toBe(true);
    expect(
      reply?.tags.some((tag) => tag[0] === "p" && tag[1] === agentPubkey),
    ).toBe(true);
    await expect(tile.getByTestId("agent-tile-open-thread")).toBeVisible();

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: `${SHOTS}/01-agent-tile.png`,
    });
  });
});
