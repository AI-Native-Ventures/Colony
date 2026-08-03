import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

// Source of the marketing site's feature imagery (site/public/feature-*.png).
//
// These were previously hand-cropped at 1x and came out 195x111 — small
// enough that one was cut off mid-sentence, and far too low-resolution for
// the full-width sections the site renders them in. Captured here instead so
// they are reproducible, seeded deterministically, and retina-density.
//
// Regenerate:
//   pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts
//   cp test-results/site-features/*.png ../site/public/
//
// Each capture is scoped to a locator rather than a pixel clip, so message
// ordering or layout shifts reframe the shot instead of slicing content.
const SHOTS = "test-results/site-features";

// Messages are dropped silently without a live subscription for the channel.
async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false,
        channelName,
      ),
    )
    .toBe(true);
}

// Retina density: these render up to ~1000 CSS px wide on the site, so a 1x
// capture would be visibly soft.
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

const REVIEWER = {
  pubkey: TEST_IDENTITIES.alice.pubkey,
  name: "mira",
  status: "running" as const,
};
const RELEASE_BOT = {
  pubkey: TEST_IDENTITIES.bob.pubkey,
  name: "nadia",
  status: "running" as const,
};

test("capture: channel list", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("channel-general")).toBeVisible();
  await waitForAnimations(page);

  // The sidebar only: the community chip at its foot carries a bee emoji from
  // an old mock fixture, so the shot stops above it rather than shipping a
  // Buzz-era glyph on a Colony page.
  await page.screenshot({
    path: `${SHOTS}/feature-channels.png`,
    clip: { x: 0, y: 0, width: 290, height: 600 },
  });
});

test("capture: agent teams", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [
      { ...REVIEWER, channelNames: ["engineering"] },
      { ...RELEASE_BOT, channelNames: ["engineering"] },
    ],
  });
  // Taller window: the agent cards sit low enough that a 720px viewport
  // clipped their names against the fold.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("unified-agents-groups")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByTestId(`managed-agent-${REVIEWER.pubkey}`),
  ).toBeVisible({ timeout: 10_000 });
  await waitForAnimations(page);

  // The group container leads with a large empty "new agent" placeholder,
  // which would be most of the frame. Scope to the two agent cards instead.
  const first = page.getByTestId(`managed-agent-${REVIEWER.pubkey}`);
  const second = page.getByTestId(`managed-agent-${RELEASE_BOT.pubkey}`);
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error("could not measure the agent cards");
  // Generous bottom padding: the agent name and model sit below the card's
  // measured box, and a tight crop sheared them off.
  const pad = 20;
  await page.screenshot({
    path: `${SHOTS}/feature-agents.png`,
    clip: {
      x: Math.min(a.x, b.x) - pad,
      y: Math.min(a.y, b.y) - pad,
      width:
        Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) + pad * 2,
      height:
        Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) + pad * 4,
    },
  });
});

test("capture: workflow run reported in a channel", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [{ ...RELEASE_BOT, channelNames: ["engineering"] }],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await expect(page.getByTestId("chat-title")).toHaveText("engineering");

  // One message only: two messages emitted in the same second sort
  // unstably, which made a fixed crop land on a different message per run.
  await waitForMockLiveSubscription(page, "engineering");
  await page.evaluate((pubkey) => {
    (
      window as unknown as {
        __BUZZ_E2E_EMIT_MOCK_MESSAGE__: (
          input: Record<string, unknown>,
        ) => void;
      }
    ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__({
      channelName: "engineering",
      content:
        "Workflow `release-sign` triggered on push. Build signed, notarization queued. I'll post the ticket ID here when Apple returns it.",
      pubkey,
    });
  }, RELEASE_BOT.pubkey);

  const row = page.getByTestId("message-row").last();
  await expect(row).toContainText("release-sign");
  await waitForAnimations(page);
  const box = await row.boundingBox();
  if (!box) throw new Error("could not measure the workflow message");
  // Anchor on the message but keep the channel around it: a bare row is a
  // 20:1 sliver on the page and reads as a stray line of text.
  // Frame the message with the composer beneath it, not the empty-channel
  // onboarding cards above it — those belong to a different story.
  await page.screenshot({
    path: `${SHOTS}/feature-workflow.png`,
    clip: {
      x: 290,
      y: Math.max(0, box.y - 30),
      width: 990,
      height: 240,
    },
  });
});

test("capture: git built in", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await waitForAnimations(page);

  // Stops above the commit feed: its top row is a push to a repo the mock
  // names "buzz", and a Buzz-era repo name has no place in Colony imagery.
  await page.screenshot({
    path: `${SHOTS}/feature-git.png`,
    clip: { x: 290, y: 0, width: 990, height: 350 },
  });
});
