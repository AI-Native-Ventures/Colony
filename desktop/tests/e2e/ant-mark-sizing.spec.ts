import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

// Regression net for the "giant ant" bug. The FuzzyMark's inner svg carried
// its own boot-splash-sized width rule, so wrapper utilities like `w-5!`
// never constrained it; and the mark's stylesheet shipped in a lazy chunk,
// so surfaces outside that chunk rendered the svg at the browser's 300x150
// replaced-element default. Both failure modes produced a huge ant in the
// agent Activity surfaces. These tests measure the RENDERED svg box —
// source-level fixes shipped twice without catching this.

// Charlie authors the seeded "Indexing the channel catalog now." message in
// #agents (see e2eBridge.ts). Seeding a managed agent with the same pubkey
// makes the message avatar open the managed-agent profile panel, whose
// Latest Activity card mounts the transcript's waiting mark while a turn is
// live with no ACP data yet — the exact surface the bug shipped on.
const AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";

const CHANNEL_GENERAL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

async function waitForBridge(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () =>
      typeof (window as Window & { __BUZZ_E2E_SEED_ACTIVE_TURNS__?: unknown })
        .__BUZZ_E2E_SEED_ACTIVE_TURNS__ === "function",
    null,
    { timeout: 10_000 },
  );
}

test.describe("ant mark sizing", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("activity waiting mark renders icon-sized, not splash-sized", async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: "Charlie",
          status: "running",
          channelNames: ["agents"],
        },
      ],
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForBridge(page);
    await page.getByTestId("channel-agents").click();
    await expect(page.getByTestId("chat-title")).toHaveText("agents");

    await page.evaluate(
      ({ pubkey, channelId }) => {
        const win = window as Window & {
          __BUZZ_E2E_SEED_ACTIVE_TURNS__?: (input: {
            agentPubkey: string;
            channelId: string;
            turnId: string;
          }) => void;
        };
        win.__BUZZ_E2E_SEED_ACTIVE_TURNS__?.({
          agentPubkey: pubkey,
          channelId,
          turnId: "turn-ant-size",
        });
      },
      { pubkey: AGENT_PUBKEY, channelId: CHANNEL_GENERAL },
    );

    // Address Charlie's row by its content, not by position. #agents seeds
    // Charlie, nadia, and one message per managed agent that is a member, and
    // which of those is last depends on seeding order: a CI failure on
    // 2026-08-18 opened nadia's profile instead and then looked for Charlie's
    // live-activity card in it.
    await page
      .getByTestId("message-row")
      .filter({ hasText: "Indexing the channel catalog now." })
      .first()
      .getByRole("button")
      .first()
      .click();

    const panel = page.getByTestId("user-profile-panel");
    await expect(panel).toBeVisible();
    const liveActivity = panel.getByTestId(
      `user-profile-live-activity-${AGENT_PUBKEY}`,
    );
    await expect(liveActivity).toBeVisible({ timeout: 5_000 });

    const waitingMark = liveActivity.getByRole("img", {
      name: "Waiting for ACP activity",
    });
    await expect(waitingMark).toBeVisible({ timeout: 5_000 });

    const svgBox = await waitingMark.locator("svg").boundingBox();
    expect(svgBox).not.toBeNull();
    if (!svgBox) return;
    // The mark is mounted with `w-8!` (2rem = 32px). Rendering wider means a
    // sizing rule regressed: either the svg reclaimed its own width or the
    // sizing stylesheet is missing from the entry bundle again.
    expect(svgBox.width).toBeGreaterThan(8);
    expect(svgBox.width).toBeLessThanOrEqual(40);
    expect(svgBox.height).toBeLessThanOrEqual(40);
  });

  test("mark sizing survives without the lazy colony-logo stylesheet", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForBridge(page);

    // Prove the sizing rules ship in an always-loaded stylesheet: an ant
    // mark mounted cold (no profile-panel chunk loaded) must resolve the
    // component defaults from CSS already on the page.
    const measured = await page.evaluate(() => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      host.innerHTML =
        '<span class="colony-logo"><svg class="colony-logo__mark" viewBox="0 0 466 309"></svg></span>';
      const wrapper = host.firstElementChild as HTMLElement;
      const svg = wrapper.firstElementChild as SVGElement;
      const wrapperBox = wrapper.getBoundingClientRect();
      const svgBox = svg.getBoundingClientRect();
      host.remove();
      return {
        svgWidth: svgBox.width,
        wrapperWidth: wrapperBox.width,
      };
    });

    // Unsized mount must fall back to the icon-sized wrapper default
    // (1.5rem = 24px), never to 466px or the 300px svg default.
    expect(measured.wrapperWidth).toBeGreaterThan(8);
    expect(measured.wrapperWidth).toBeLessThanOrEqual(32);
    expect(measured.svgWidth).toBeLessThanOrEqual(32);
  });
});
