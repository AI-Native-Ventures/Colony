import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

type MockMessageWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
    channelName: string;
    content: string;
    parentEventId?: string | null;
    pubkey?: string;
  }) => { id: string } | undefined;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
  }) => boolean;
};

const CHANNEL_NAME = "engineering";
const MOCK_IDENTITY_PUBKEY = "deadbeef".repeat(8);
const ALICE_PUBKEY =
  "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f";

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(async () => {
      return page.evaluate((name) => {
        return (
          (
            window as MockMessageWindow
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: name }) ??
          false
        );
      }, channelName);
    })
    .toBe(true);
}

test.describe("auxiliary pane close visibility", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  // Regression for #6901: `isolate` on the right auxiliary pane makes it its
  // own stacking context. With no z-index (`auto`, i.e. level 0) the entire
  // pane subtree — including the z-40 header chrome where X/Edit live — paints
  // below the channel's sibling z-30 shared-header backdrop in split layout,
  // washing out the controls (they stay clickable because the backdrop is
  // pointer-events-none, matching the reported videos). The pane's own
  // stacking level must sit above the backdrop for the header to show through.
  test("close button paints above the shared header backdrop in a channel thread", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
    await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
    await waitForMockLiveSubscription(page, CHANNEL_NAME);

    const rootId = await page.evaluate(
      ({ channelName, pubkey }) =>
        (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName,
          content: "Root message for auxiliary pane close visibility.",
          pubkey,
        })?.id ?? null,
      { channelName: CHANNEL_NAME, pubkey: MOCK_IDENTITY_PUBKEY },
    );
    expect(rootId).not.toBeNull();

    await page.evaluate(
      ({ channelName, parentEventId, pubkey }) => {
        (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName,
          content: "Reply that opens a split thread panel.",
          parentEventId,
          pubkey,
        });
      },
      {
        channelName: CHANNEL_NAME,
        parentEventId: rootId,
        pubkey: ALICE_PUBKEY,
      },
    );

    const replyButton = page.locator('[data-testid^="reply-message-"]').first();
    await expect(replyButton).toBeVisible();
    await replyButton.click({ force: true });
    await expect(page.getByTestId("message-thread-panel")).toBeVisible();
    await waitForAnimations(page);

    const closeButton = page.getByTestId("auxiliary-panel-close");
    await expect(closeButton).toBeVisible();

    const backdrop = page.getByTestId("channel-shared-header-backdrop");
    await expect(backdrop).toHaveCount(1);

    // Upstream asserts `isolation: isolate` and a z-index on
    // `message-thread-panel`; in Colony that stacking context belongs to
    // `RightAuxiliaryPane`, which only wraps the panel in split layout, so the
    // panel itself carries neither. What the fix has to guarantee either way is
    // that the backdrop does not swallow the close button, so this hit-tests
    // the button's own centre point.
    const closeBox = await closeButton.boundingBox();
    if (!closeBox) throw new Error("Expected the close button to have a box");
    const topElementOwnsClose = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit?.closest('[data-testid="auxiliary-panel-close"]'));
      },
      {
        x: closeBox.x + closeBox.width / 2,
        y: closeBox.y + closeBox.height / 2,
      },
    );

    expect(topElementOwnsClose).toBe(true);
  });
});
