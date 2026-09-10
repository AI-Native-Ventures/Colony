import { expect, test, type Locator, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/workspace-factory-graph";

/** The mock bridge's own identity — the owner node in the graph. */
const OWNER = "deadbeef".repeat(8);
const AVERY = TEST_IDENTITIES.alice.pubkey;
const VERA = TEST_IDENTITIES.bob.pubkey;

type EmitInput = {
  channelName: string;
  content: string;
  pubkey?: string;
  mentionPubkeys?: string[];
  parentEventId?: string | null;
  createdAt?: number;
};

type EmitWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: EmitInput) => { id: string };
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
  }) => boolean;
};

async function waitForMockLiveSubscription(
  page: Page,
  channelName: string,
): Promise<void> {
  // The bridge installs its globals from a lazily loaded chunk, so wait for the
  // seam itself before polling a value through it.
  await page.waitForFunction(
    () =>
      typeof (window as EmitWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__ ===
      "function",
  );
  await expect
    .poll(async () =>
      page.evaluate(
        (name) =>
          (window as EmitWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false,
        channelName,
      ),
    )
    .toBe(true);
}

async function emit(page: Page, input: EmitInput): Promise<string> {
  return page.evaluate((payload) => {
    const emitted = (window as EmitWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.(
      payload,
    );
    if (!emitted) throw new Error("mock message emitter is not installed");
    return emitted.id;
  }, input);
}

function edge(page: Page, from: string, to: string): Locator {
  return page.getByTestId(`comm-graph-edge-${from}-${to}`);
}

/**
 * Click an edge on the curve itself.
 *
 * An edge's bounding box centre is usually nowhere near its curve, so a plain
 * `click()` would land on whatever sits under the box. Walk to the midpoint of
 * the hit path and click there, which also proves the widened transparent
 * stroke is what makes a 1.5-unit line clickable.
 */
async function clickEdge(page: Page, from: string, to: string): Promise<void> {
  const point = await edge(page, from, to)
    .locator("path")
    .first()
    .evaluate((element) => {
      const path = element as unknown as SVGPathElement;
      const onCurve = path.getPointAtLength(path.getTotalLength() / 2);
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error("edge path has no screen CTM");
      const screen = new DOMPoint(onCurve.x, onCurve.y).matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
}

test.describe("factory communication graph tile", () => {
  test("draws nodes and edges from relay events and fills the rail", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        { pubkey: AVERY, name: "Avery", channelNames: ["general"] },
        { pubkey: VERA, name: "Vera", channelNames: ["general"] },
      ],
    });
    await page.goto("/");

    // Seed the conversation from inside the channel, where the live
    // subscription exists: messages emitted without one are dropped.
    await page.getByTestId("channel-general").click();
    await waitForMockLiveSubscription(page, "general");

    const recent = Math.floor(Date.now() / 1_000) - 60;
    await emit(page, {
      channelName: "general",
      content: "@Avery take the CSV export ticket",
      mentionPubkeys: [AVERY],
      createdAt: recent,
    });
    await emit(page, {
      channelName: "general",
      content: "@Avery and keep the filters shared",
      mentionPubkeys: [AVERY],
      createdAt: recent + 1,
    });
    await emit(page, {
      channelName: "general",
      content: "On it — pushing a branch now",
      pubkey: AVERY,
      mentionPubkeys: [OWNER],
      createdAt: recent + 2,
    });
    await emit(page, {
      channelName: "general",
      content: "@Vera review #684 for CSV escaping",
      pubkey: AVERY,
      mentionPubkeys: [VERA],
      createdAt: recent + 3,
    });
    const rootId = await emit(page, {
      channelName: "general",
      content: "Branch is up: feat/billing-export",
      pubkey: AVERY,
      createdAt: recent + 4,
    });
    await emit(page, {
      channelName: "general",
      content: "Quotes inside memo fields are not doubled",
      pubkey: VERA,
      parentEventId: rootId,
      createdAt: recent + 5,
    });

    // Open the workspace and the factory, then the graph from its toolbar.
    const toggle = page.getByTestId("channel-workspace-toggle");
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      await toggle.click();
    }
    await expect(page.getByTestId("channel-workspace")).toBeVisible();
    // The graph is offered on its own in a project channel too.
    await expect(page.getByTestId("workspace-create-comm-graph")).toBeVisible();
    await page.getByTestId("workspace-create-factory").click();
    await expect(page.getByTestId("factory-canvas")).toBeVisible();
    await page.getByTestId("factory-open-graph").click();

    await expect(page.getByTestId("comm-graph-body")).toBeVisible();
    for (const pubkey of [OWNER, AVERY, VERA]) {
      await expect(page.getByTestId(`comm-graph-node-${pubkey}`)).toBeVisible();
    }

    // Two mentions one way, one back, one agent-to-agent mention, and the
    // thread reply edging back to the root's author.
    await expect(edge(page, OWNER, AVERY)).toHaveAttribute("data-count", "2");
    await expect(edge(page, AVERY, OWNER)).toHaveAttribute("data-count", "1");
    await expect(edge(page, AVERY, VERA)).toHaveAttribute("data-count", "1");
    await expect(edge(page, VERA, AVERY)).toHaveAttribute("data-count", "1");
    // Nobody mentioned themselves and the owner never mentioned Vera.
    await expect(edge(page, OWNER, OWNER)).toHaveCount(0);
    await expect(edge(page, OWNER, VERA)).toHaveCount(0);

    // Nothing is selected until an edge is clicked.
    const rail = page.getByTestId("comm-graph-rail");
    await expect(rail).toContainText("Click an edge");

    await clickEdge(page, OWNER, AVERY);
    await expect(edge(page, OWNER, AVERY)).toHaveAttribute(
      "data-selected",
      "true",
    );
    // The pair's traffic in both directions: two out, one back.
    await expect(page.getByTestId("comm-graph-rail-message")).toHaveCount(3);
    await expect(rail).toContainText("You");
    await expect(rail).toContainText("Avery");
    await expect(rail).toContainText("take the CSV export ticket");
    await expect(rail).toContainText("pushing a branch now");
    // Vera's side of the graph is not in this pair's rail.
    await expect(rail).not.toContainText("memo fields");

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: `${SHOTS}/01-graph.png`,
    });

    // Selecting the agent-to-agent pair swaps the rail over.
    await clickEdge(page, AVERY, VERA);
    await expect(page.getByTestId("comm-graph-rail-message")).toHaveCount(2);
    await expect(rail).toContainText("memo fields");

    // The window chip narrows the graph: a 40-minute-old message is outside the
    // 30-minute window and inside the 2-hour one.
    await emit(page, {
      channelName: "general",
      content: "Older hand-off, outside the 30 minute window",
      pubkey: VERA,
      mentionPubkeys: [OWNER],
      createdAt: Math.floor(Date.now() / 1_000) - 40 * 60,
    });
    await expect(edge(page, VERA, OWNER)).toHaveCount(0);
    await page.getByTestId("comm-graph-window-2h").click();
    await expect(edge(page, VERA, OWNER)).toHaveAttribute("data-count", "1");
  });
});
