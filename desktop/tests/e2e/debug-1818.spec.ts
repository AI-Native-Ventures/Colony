// TEMPORARY diagnostic spec. Reproduces the messaging.spec.ts:1818 Linux-only
// failure and, on failure, dumps the three states that separate a send-path
// bug from a store/render bug: what the mock relay published, what
// get_channel_window returns, and what the DOM actually holds.
// Delete with the branch.
import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("sends a thread message to its parent channel with a root-thread link", async ({
  page,
}) => {
  const timestamp = Date.now();
  const rootContent = `🧵 Share source thread ${timestamp}`;
  const priorChannelMessage = `Prior channel message ${timestamp}`;
  const replySummary = `Share this reply ${timestamp}`;
  const attachmentSha = "d".repeat(64);
  const attachmentUrl = `http://localhost:3000/media/${attachmentSha}.txt`;
  const customEmojiUrl = "https://example.com/send-to-channel-party.svg";
  const previewUrl = "https://github.com/block/buzz/pull/5305";
  const ownReplyContent = [
    `${replySummary} with @alice :party:`,
    `[launch-notes.txt](${attachmentUrl})`,
    previewUrl,
  ].join("\n\n");
  const imetaTag = [
    "imeta",
    `url ${attachmentUrl}`,
    "m text/plain",
    `x ${attachmentSha}`,
    "size 42",
    "filename launch-notes.txt",
  ];
  const emojiTag = ["emoji", "party", customEmojiUrl];
  const mentionTag = ["mention", TEST_IDENTITIES.alice.pubkey];
  const linkPreviewTag = [
    "link-preview",
    "snapshot",
    "1",
    previewUrl,
    "Add Send to channel for thread messages",
    "GitHub",
    "A shared link preview preserved from the source thread message.",
    "",
    "",
    "",
    "",
  ];

  await page.route(customEmojiUrl, (route) =>
    route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#a78bfa"/><path d="M8 18l5 5 11-13" fill="none" stroke="white" stroke-width="3"/></svg>',
      contentType: "image/svg+xml",
    }),
  );

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
      (window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
        channelName: "general",
      }) ??
        false),
  );

  const { ownReplyId, rootId } = await page.evaluate(
    ({ alicePubkey, ownReply, root, semanticTags }) => {
      const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) throw new Error("Mock message emitter is unavailable.");
      const rootEvent = emit({
        channelName: "general",
        content: root,
        pubkey: alicePubkey,
      });
      const ownReplyEvent = emit({
        channelName: "general",
        content: ownReply,
        extraTags: semanticTags,
        mentionPubkeys: [alicePubkey],
        parentEventId: rootEvent.id,
      });
      return {
        ownReplyId: ownReplyEvent.id,
        rootId: rootEvent.id,
      };
    },
    {
      alicePubkey: TEST_IDENTITIES.alice.pubkey,
      ownReply: ownReplyContent,
      root: rootContent,
      semanticTags: [imetaTag, emojiTag, mentionTag, linkPreviewTag],
    },
  );

  const timeline = page.getByTestId("message-timeline");
  const rootRow = timeline.locator(`[data-message-id="${rootId}"]`);
  await expect(rootRow).toContainText(rootContent);

  await page.getByTestId("message-input").fill(priorChannelMessage);
  await page.getByTestId("send-message").click();
  const priorChannelRow = timeline
    .getByTestId("message-row")
    .filter({ hasText: priorChannelMessage });
  await expect(priorChannelRow).toBeVisible();
  await expect(priorChannelRow.getByTestId("message-send-status")).toHaveCount(
    0,
  );

  await timeline
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
    )
    .click();
  const threadPanel = page.getByTestId("message-thread-panel");
  const threadRootRow = threadPanel.locator(`[data-message-id="${rootId}"]`);
  const rootMoreActions = threadRootRow.getByTestId(`more-actions-${rootId}`);
  await rootMoreActions.click({ force: true });
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Send to channel" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  const ownReplyRow = threadPanel.locator(`[data-message-id="${ownReplyId}"]`);
  await expect(ownReplyRow).toContainText(replySummary);
  await ownReplyRow
    .getByTestId(`more-actions-${ownReplyId}`)
    .click({ force: true });
  const sendToChannelItem = page.getByRole("menuitem", {
    name: "Send to channel",
  });
  const sendToChannelIcon = sendToChannelItem.getByTestId(
    "send-to-channel-icon",
  );
  await expect(sendToChannelIcon).toBeVisible();
  await expect(sendToChannelIcon).toHaveAttribute("aria-hidden", "true");
  await expect(sendToChannelIcon).toHaveClass(/lucide-hash-arrow-in/);
  await expect
    .poll(async () => {
      const box = await sendToChannelIcon.boundingBox();
      return box ? [box.width, box.height] : null;
    })
    .toEqual([16, 16]);
  await sendToChannelItem.click();

  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Sent to channel" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate((content) => {
        return Boolean(
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).findLast(
            (entry) =>
              entry.command === "send_channel_message" &&
              (entry.payload as { content?: string } | undefined)?.content ===
                content,
          ),
        );
      }, ownReplyContent),
    )
    .toBe(true);
  const sentPayload = await page.evaluate(
    (content) =>
      (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).findLast(
        (entry) =>
          entry.command === "send_channel_message" &&
          (entry.payload as { content?: string } | undefined)?.content ===
            content,
      )?.payload as Record<string, unknown> | undefined,
    ownReplyContent,
  );
  expect(sentPayload).toMatchObject({
    channelId: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
    content: ownReplyContent,
    emojiTags: [emojiTag],
    linkPreviewTags: [linkPreviewTag],
    mediaTags: [imetaTag],
    mentionPubkeys: [TEST_IDENTITIES.alice.pubkey],
    mentionTags: [mentionTag],
    parentEventId: null,
    sentFromThreadTag: ["buzz:sent-from-thread", rootId, rootContent],
  });

  await page.getByTestId("auxiliary-panel-close").click();

  const sharedRow = timeline
    .getByTestId("message-row")
    .filter({ hasText: replySummary })
    .last();
  let appeared = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await sharedRow.isVisible()) {
      appeared = true;
      break;
    }
    const scrollToLatest = page.getByTestId("message-scroll-to-latest");
    if (await scrollToLatest.isVisible()) await scrollToLatest.click();
    await page.waitForTimeout(100);
  }

  if (!appeared) {
    const diagnostics = await page.evaluate(async (summary) => {
      const published = (window.__BUZZ_E2E_PUBLISHED_EVENTS__ ?? []).map(
        (event) => ({
          id: event.id,
          created_at: event.created_at,
          content: event.content.slice(0, 48),
        }),
      );
      let windowRows: unknown = "unavailable";
      try {
        const result = await window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.(
          "get_channel_window",
          { channelId: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50", limit: 50 },
        );
        windowRows = JSON.stringify(result).slice(0, 4000);
      } catch (error) {
        windowRows = `error: ${String(error)}`;
      }
      const rows = Array.from(
        document.querySelectorAll('[data-testid="message-row"]'),
      ).map((element) => ({
        id: (element as HTMLElement).dataset.messageId ?? null,
        text: (element.textContent ?? "").slice(0, 48),
      }));
      const scroller = document.querySelector(
        '[data-testid="message-timeline"] [data-overlayscrollbars-viewport], [data-testid="message-timeline"] .overflow-y-auto',
      ) as HTMLElement | null;
      return {
        summary,
        publishedHasSummary: published.some((event) =>
          event.content.includes(summary),
        ),
        published,
        rows,
        pillPresent: Boolean(
          document.querySelector('[data-testid="message-scroll-to-latest"]'),
        ),
        scroll: scroller
          ? {
              scrollTop: scroller.scrollTop,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            }
          : null,
        windowRows,
      };
    }, replySummary);
    console.log(`DEBUG1818 ${JSON.stringify(diagnostics)}`);
  }

  expect(appeared).toBe(true);
});
