import { expect, test } from "@playwright/test";

import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

// The mock bridge seeds `threadCanvases` keyed on (channelId, threadRootId).
// The engineering channel's fixed fixture UUID; thread root ids are chosen
// by the specs themselves (the mock message emitter accepts an explicit id).
const ENGINEERING_CHANNEL_ID = "1c7e1c02-87bb-5e88-b2da-5a7a9432d0c9";
const ROOT_A = "thread-canvas-root-a";
const ROOT_B = "thread-canvas-root-b";

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ ch }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: ch }) ??
          false,
        { ch: channelName },
      );
    })
    .toBe(true);
}

/**
 * Emits a level-1 root plus one reply so the timeline renders a thread
 * summary row for it, and the summary can be clicked to open the panel.
 */
async function seedThreadWithReply(
  page: import("@playwright/test").Page,
  rootId: string,
  rootContent: string,
) {
  const emit = (input: {
    channelName: string;
    content: string;
    id?: string;
    parentEventId?: string | null;
    pubkey?: string;
  }) =>
    page.evaluate(
      ({ msg }) => {
        return (
          window as Window & {
            __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
              channelName: string;
              content: string;
              id?: string;
              parentEventId?: string | null;
              pubkey?: string;
            }) => { id: string };
          }
        ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.(msg);
      },
      { msg: input },
    );

  await emit({
    channelName: "engineering",
    content: rootContent,
    id: rootId,
    pubkey: TEST_IDENTITIES.alice.pubkey,
  });
  await emit({
    channelName: "engineering",
    content: "Reply so the thread has a summary row",
    parentEventId: rootId,
    pubkey: TEST_IDENTITIES.bob.pubkey,
  });
}

async function openChannel(page: import("@playwright/test").Page) {
  await page.getByTestId("channel-engineering").click();
  await expect(page.getByTestId("chat-title")).toHaveText("engineering");
  await waitForMockLiveSubscription(page, "engineering");
}

async function openThread(
  page: import("@playwright/test").Page,
  rootId: string,
) {
  await page
    .locator(
      `[data-thread-head-id="${rootId}"][data-testid="message-thread-summary"]`,
    )
    .click();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

test.describe("thread canvas panel", () => {
  test("renders expanded with seeded content", async ({ page }) => {
    await installMockBridge(page, {
      threadCanvases: [
        {
          channelId: ENGINEERING_CHANNEL_ID,
          threadRootId: ROOT_A,
          content: "**Hero scroll**: cinematic treatment approved by client.",
        },
      ],
    });
    await page.goto("/");
    await openChannel(page);
    await seedThreadWithReply(page, ROOT_A, "Reworking the hero section");

    await openThread(page, ROOT_A);

    const panel = page.getByTestId("thread-canvas-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("thread-canvas-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Seeded markdown renders through the Markdown viewer.
    await expect(panel.getByTestId("thread-canvas-content")).toContainText(
      "cinematic treatment approved by client",
    );
  });

  test("edit and save round-trips and refreshes the view", async ({ page }) => {
    await installMockBridge(page, {
      threadCanvases: [
        {
          channelId: ENGINEERING_CHANNEL_ID,
          threadRootId: ROOT_A,
          content: "First recorded finding.",
        },
      ],
    });
    await page.goto("/");
    await openChannel(page);
    await seedThreadWithReply(page, ROOT_A, "Thread being worked");

    await openThread(page, ROOT_A);

    await page.getByTestId("thread-canvas-edit").click();
    const editor = page.getByTestId("thread-canvas-editor");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue("First recorded finding.");
    await editor.fill("Updated after the review call.");
    await page.getByTestId("thread-canvas-save").click();

    // Save invalidates ["thread-canvas", channel, root]; the refetch reads
    // the mock store back and the viewer shows the new content.
    const content = page.getByTestId("thread-canvas-content");
    await expect(content).toContainText("Updated after the review call.");
    await expect(editor).toHaveCount(0);
  });

  test("empty state reads as nothing recorded yet", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await openChannel(page);
    await seedThreadWithReply(page, ROOT_A, "Fresh thread without memory");

    await openThread(page, ROOT_A);

    const panel = page.getByTestId("thread-canvas-panel");
    await expect(panel).toBeVisible();
    // Empty canvas collapses by default; no error styling anywhere.
    await expect(panel.getByTestId("thread-canvas-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(panel.getByTestId("thread-canvas-empty-hint")).toHaveText(
      "Nothing recorded yet",
    );

    await panel.getByTestId("thread-canvas-toggle").click();
    await expect(panel.getByTestId("thread-canvas-empty")).toContainText(
      "Nothing recorded yet",
    );
    // A human can correct or start the record.
    await expect(panel.getByTestId("thread-canvas-edit")).toBeVisible();
  });

  test("two threads in one channel show different canvases", async ({
    page,
  }) => {
    await installMockBridge(page, {
      threadCanvases: [
        {
          channelId: ENGINEERING_CHANNEL_ID,
          threadRootId: ROOT_A,
          content: "Canvas A: hero scroll treatment.",
        },
        {
          channelId: ENGINEERING_CHANNEL_ID,
          threadRootId: ROOT_B,
          content: "Canvas B: refund flow edge cases.",
        },
      ],
    });
    await page.goto("/");
    await openChannel(page);
    await seedThreadWithReply(page, ROOT_A, "Thread A");
    await seedThreadWithReply(page, ROOT_B, "Thread B");

    await openThread(page, ROOT_A);
    await expect(page.getByTestId("thread-canvas-content")).toContainText(
      "Canvas A: hero scroll treatment.",
    );
    // Wide layouts keep the timeline interactive beside the open thread
    // panel, so switching threads is a direct summary-row click; the back
    // control only exists in the narrow single-panel view.
    await openThread(page, ROOT_B);
    await expect(page.getByTestId("thread-canvas-content")).toContainText(
      "Canvas B: refund flow edge cases.",
    );
    // And the first canvas did not bleed into this thread's view.
    await expect(page.getByTestId("thread-canvas-panel")).not.toContainText(
      "Canvas A",
    );
  });

  test("over-cap rejection surfaces as a readable message", async ({
    page,
  }) => {
    const overCapMessage =
      "relay rejected event: canvas exceeds maximum size of 4096 bytes for thread canvases; trim before retrying";
    await installMockBridge(page, {
      threadCanvasSaveErrors: [overCapMessage],
    });
    await page.goto("/");
    await openChannel(page);
    await seedThreadWithReply(page, ROOT_A, "Thread hitting the cap");

    await openThread(page, ROOT_A);

    const panel = page.getByTestId("thread-canvas-panel");
    await panel.getByTestId("thread-canvas-toggle").click();
    await panel.getByTestId("thread-canvas-edit").click();
    await page.getByTestId("thread-canvas-editor").fill("Too long record");
    await page.getByTestId("thread-canvas-save").click();

    await expect(page.getByTestId("thread-canvas-save-error")).toHaveText(
      overCapMessage,
    );
    // The editor stays open so the draft can be trimmed rather than lost.
    await expect(page.getByTestId("thread-canvas-editor")).toBeVisible();
  });
});
