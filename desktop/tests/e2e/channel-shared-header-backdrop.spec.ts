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

test.describe("retired theme channel layout migration", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("uses separate Default channel and thread surfaces without the legacy backdrop", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("buzz-theme", "github-light");
      localStorage.setItem("buzz-follow-system", "false");
    });
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId(`channel-${CHANNEL_NAME}`).click();
    await expect(page.getByTestId("chat-title")).toHaveText(CHANNEL_NAME);
    await waitForMockLiveSubscription(page, CHANNEL_NAME);

    const rootId = await page.evaluate(
      ({ channelName, pubkey }) =>
        (window as MockMessageWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName,
          content: "Root message for shared header backdrop coverage.",
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
    // Retry the click until the panel opens, rather than clicking once and
    // asserting. A visible reply button is not necessarily a wired one: under
    // CI contention the click can land before the row's handler is attached,
    // and it then goes nowhere. The failure reads as "message-thread-panel not
    // found", which looks like the panel being broken rather than a click that
    // was never received. Opening an already-open thread is a no-op, so
    // retrying is safe.
    const threadPanel = page.getByTestId("message-thread-panel");
    await expect
      .poll(async () => {
        if ((await threadPanel.count()) === 0) {
          await replyButton.click({ force: true });
        }
        return threadPanel.count();
      })
      .toBeGreaterThan(0);
    await expect(threadPanel).toBeVisible();

    const sharedBackdrop = page.getByTestId("channel-shared-header-backdrop");
    await expect(sharedBackdrop).toHaveCount(1);

    await expect(page.locator("html")).toHaveAttribute(
      "data-buzz-theme",
      "buzz",
    );
    await expect(sharedBackdrop).toBeHidden();
    const channel = page.getByTestId("channel-drop-zone");
    await expect(channel).toBeVisible();
    await expect(threadPanel).toBeVisible();
    await waitForAnimations(page);
    const channelBox = await channel.boundingBox();
    const threadBox = await threadPanel.boundingBox();
    expect(channelBox).not.toBeNull();
    expect(threadBox).not.toBeNull();
    if (!channelBox || !threadBox)
      throw new Error("Split pane geometry missing");
    expect(threadBox.x).toBeGreaterThanOrEqual(channelBox.x + channelBox.width);
    expect(channelBox.width).toBeGreaterThan(0);
    expect(threadBox.width).toBeGreaterThan(0);
    await expect(threadPanel).toHaveCSS("animation-name", "none");

    await waitForAnimations(page);
  });
});
