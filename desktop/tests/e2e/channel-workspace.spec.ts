import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const FOCUS_THREAD_RATIO = 0.2;
const FOCUS_THREAD_MIN_WIDTH_PX = 280;
const FOCUS_WORKSPACE_MIN_WIDTH_PX = 320;
const RELAY_URL = "ws://localhost:3000";
const WORKSPACE_COMMUNITIES = [
  {
    id: "workspace-focus-community-a",
    name: "Alpha",
    relayUrl: RELAY_URL,
    addedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "workspace-focus-community-b",
    name: "Bravo",
    relayUrl: "ws://localhost:3001",
    addedAt: "2026-01-02T00:00:00.000Z",
  },
];

function expectedFocusThreadWidth(containerWidth: number): number {
  const maximum = Math.max(0, containerWidth - FOCUS_WORKSPACE_MIN_WIDTH_PX);
  const minimum = Math.min(FOCUS_THREAD_MIN_WIDTH_PX, maximum);
  return Math.max(
    minimum,
    Math.min(maximum, containerWidth * FOCUS_THREAD_RATIO),
  );
}

async function emitThreadReplies(
  page: import("@playwright/test").Page,
  contents: string[],
) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "general",
          }) ?? false,
      ),
    )
    .toBe(true);
  await page.evaluate(
    ({ createdAt, messageContents, pubkey }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            createdAt: number;
            parentEventId: string;
            pubkey: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      for (const [index, content] of messageContents.entries()) {
        emit?.({
          channelName: "general",
          content,
          createdAt: createdAt + index,
          parentEventId: "mock-general-welcome",
          pubkey,
        });
      }
    },
    {
      createdAt: Math.floor(Date.now() / 1000) + 100,
      messageContents: contents,
      pubkey: TEST_IDENTITIES.alice.pubkey,
    },
  );
}

async function emitThreadReply(
  page: import("@playwright/test").Page,
  content = "Thread reply for dock ordering",
) {
  await emitThreadReplies(page, [content]);
}

test.describe("channel workspace", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page, undefined, { skipCommunitySeed: true });
    await page.addInitScript(
      ({ communities, activeCommunityId }) => {
        window.localStorage.setItem(
          "buzz-communities",
          JSON.stringify(communities),
        );
        window.localStorage.setItem(
          "buzz-active-community-id",
          activeCommunityId,
        );
      },
      {
        communities: WORKSPACE_COMMUNITIES,
        activeCommunityId: WORKSPACE_COMMUNITIES[0].id,
      },
    );
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
  });

  test("preserves a collapsed navigation preference through workspace focus", async ({
    page,
  }) => {
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("community-rail")).toBeVisible();

    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(page.getByTestId("app-sidebar").locator("..")).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    await expect(page.getByTestId("community-rail")).toBeHidden();

    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toBeHidden();
    await expect(page.getByTestId("community-rail")).toBeHidden();
    await expect(page.getByTestId("app-top-chrome")).toBeVisible();

    await page.getByRole("button", { name: "Collapse workspace" }).click();
    await expect(page.getByTestId("app-sidebar").locator("..")).toHaveAttribute(
      "data-state",
      "collapsed",
    );
    await expect(page.getByTestId("community-rail")).toBeHidden();
  });

  test("restores expanded navigation after workspace focus", async ({
    page,
  }) => {
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("community-rail")).toBeVisible();

    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toBeHidden();
    await expect(page.getByTestId("community-rail")).toBeHidden();
    await expect(page.getByTestId("app-top-chrome")).toBeVisible();

    await page.getByRole("button", { name: "Collapse workspace" }).click();
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("community-rail")).toBeVisible();
  });

  test("uses the full content width when no thread is open", async ({
    page,
  }) => {
    const toggle = page.getByTestId("channel-workspace-toggle");
    await expect(toggle).toBeVisible();

    await expect(page.getByTestId("channel-workspace")).toHaveCount(0);
    await toggle.click();

    const workspace = page.getByTestId("channel-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("channel-drop-zone")).toBeHidden();
    await expect(page.getByTestId("workspace-pane-resize-handle")).toHaveCount(
      0,
    );

    const workspacePane = page.getByTestId("channel-workspace-pane");
    const contentBox = await workspacePane.locator("..").boundingBox();
    const workspaceBox = await workspacePane.boundingBox();
    expect(contentBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(
      Math.abs((workspaceBox?.x ?? 0) - (contentBox?.x ?? 0)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs((workspaceBox?.width ?? 0) - (contentBox?.width ?? 0)),
    ).toBeLessThanOrEqual(1);

    await waitForAnimations(page);
    await workspacePane.screenshot({
      path: "test-results/workspace/01-docked-workspace.png",
    });

    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
  });

  test("keeps an open thread at the preferred focus split", async ({
    page,
  }) => {
    await emitThreadReply(page);
    await page.getByTestId("message-thread-summary").first().click();
    await expect(page.getByTestId("message-thread-panel")).toBeVisible();

    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("channel-drop-zone")).toBeHidden();
    const focusThreadPane = page.getByTestId("workspace-focus-thread-pane");
    await expect(
      focusThreadPane.getByTestId("message-thread-panel"),
    ).toBeVisible();
    await expect(page.getByTestId("message-thread-panel")).toHaveCount(1);

    const threadBox = await focusThreadPane.boundingBox();
    const workspaceBox = await page
      .getByTestId("channel-workspace-pane")
      .boundingBox();
    expect(threadBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect((threadBox?.x ?? 0) + (threadBox?.width ?? 0)).toBeLessThanOrEqual(
      workspaceBox?.x ?? 0,
    );
    const focusWidth = (threadBox?.width ?? 0) + (workspaceBox?.width ?? 0);
    expect(
      Math.abs((threadBox?.width ?? 0) - expectedFocusThreadWidth(focusWidth)),
    ).toBeLessThanOrEqual(16);

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace-pane").locator("..").screenshot({
      path: "test-results/workspace/05-channel-thread-workspace.png",
    });
  });

  test("preserves the live thread when focus mode enters the workspace", async ({
    page,
  }) => {
    const workspaceUrl = "https://docs.example.com/focus-preservation";
    const draft = "Unsent thread draft survives focus mode";
    await emitThreadReplies(
      page,
      Array.from(
        { length: 48 },
        (_, index) =>
          `${workspaceUrl} Reply ${index}. Preserve this reading position through workspace focus mode.`,
      ),
    );
    await page.getByTestId("message-thread-summary").first().click();
    await page.getByRole("button", { name: "Expand thread" }).click();
    await expect(page.getByTestId("focus-thread-drawer")).toBeVisible();

    const threadSurface = page.getByTestId("thread-surface-content");
    const threadBody = threadSurface.getByTestId("message-thread-body");
    await expect
      .poll(() => threadBody.locator("[data-message-id]").count())
      .toBeGreaterThanOrEqual(49);
    await expect
      .poll(() =>
        threadBody.evaluate((body) => body.scrollHeight - body.clientHeight),
      )
      .toBeGreaterThan(500);
    const threadInput = threadSurface.getByTestId("message-input");
    await threadInput.fill(draft);
    await expect(threadInput).toHaveText(draft);
    await waitForAnimations(page);
    await expect
      .poll(() =>
        threadBody.evaluate(async (body) => {
          if (body.scrollTop <= 0) {
            body.scrollTop = Math.max(
              1,
              Math.floor((body.scrollHeight - body.clientHeight) / 2),
            );
          }
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          return body.scrollTop;
        }),
      )
      .toBeGreaterThan(0);
    const linkedRowId = await threadSurface.evaluate(async (surface, url) => {
      const body = surface.querySelector<HTMLElement>(
        '[data-testid="message-thread-body"]',
      );
      const input = surface.querySelector<HTMLElement>(
        '[data-testid="message-input"]',
      );
      if (!body || !input) {
        throw new Error("Expected a live thread before workspace");
      }
      if (body.scrollTop <= 0) {
        throw new Error("Expected a scrolled live thread before workspace");
      }
      const bodyRect = body.getBoundingClientRect();
      const candidate = Array.from(
        body.querySelectorAll<HTMLElement>("[data-message-id]"),
      ).find((row) => {
        const rect = row.getBoundingClientRect();
        return (
          rect.top >= bodyRect.top + 8 &&
          rect.bottom <= bodyRect.bottom - 8 &&
          row.querySelector<HTMLAnchorElement>(`a[href="${url}"]`)
        );
      });
      if (!candidate?.dataset.messageId) {
        throw new Error("Expected a fully visible linked reply");
      }
      body.scrollTop += candidate.getBoundingClientRect().top - bodyRect.top;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      const settledBodyRect = body.getBoundingClientRect();
      const link = candidate.querySelector<HTMLAnchorElement>(
        `a[href="${url}"]`,
      );
      const linkRect = link?.getBoundingClientRect();
      if (
        !link ||
        !linkRect ||
        linkRect.top < settledBodyRect.top ||
        linkRect.bottom > settledBodyRect.bottom
      ) {
        throw new Error("Expected the workspace link inside the viewport");
      }
      (
        window as Window & {
          __BUZZ_E2E_THREAD_STATE__?: {
            body: HTMLElement;
            clickAnchorId: string | null;
            clickScrollTop: number | null;
            clickTopOffsetPx: number | null;
            input: HTMLElement;
            scrollTop: number;
          };
        }
      ).__BUZZ_E2E_THREAD_STATE__ = {
        body,
        clickAnchorId: null,
        clickScrollTop: null,
        clickTopOffsetPx: null,
        input,
        scrollTop: body.scrollTop,
      };
      link.addEventListener(
        "click",
        () => {
          const state = (
            window as Window & {
              __BUZZ_E2E_THREAD_STATE__?: {
                clickAnchorId: string | null;
                clickScrollTop: number | null;
                clickTopOffsetPx: number | null;
              };
            }
          ).__BUZZ_E2E_THREAD_STATE__;
          const top = body.getBoundingClientRect().top;
          const clickAnchor = Array.from(
            body.querySelectorAll<HTMLElement>("[data-message-id]"),
          ).find((row) => row.getBoundingClientRect().bottom > top);
          if (state) {
            state.clickAnchorId = clickAnchor?.dataset.messageId ?? null;
            state.clickScrollTop = body.scrollTop;
            state.clickTopOffsetPx = clickAnchor
              ? clickAnchor.getBoundingClientRect().top - top
              : null;
          }
        },
        { capture: true, once: true },
      );
      return candidate.dataset.messageId;
    }, workspaceUrl);
    const workspaceLink = threadSurface
      .locator(`[data-message-id="${linkedRowId}"]`)
      .getByRole("link", { name: workspaceUrl });
    await expect(workspaceLink).toBeVisible();
    const linkBox = await workspaceLink.boundingBox();
    expect(linkBox).not.toBeNull();
    const linkCenter = {
      x: (linkBox?.x ?? 0) + (linkBox?.width ?? 0) / 2,
      y: (linkBox?.y ?? 0) + (linkBox?.height ?? 0) / 2,
    };
    expect(
      await page.evaluate(
        ({ url, x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("a")
            ?.getAttribute("href") === url,
        { ...linkCenter, url: workspaceUrl },
      ),
    ).toBe(true);
    await page.mouse.click(linkCenter.x, linkCenter.y);
    const clickState = await page.evaluate(() => {
      const state = (
        window as Window & {
          __BUZZ_E2E_THREAD_STATE__?: {
            clickAnchorId: string | null;
            clickScrollTop: number | null;
            clickTopOffsetPx: number | null;
            scrollTop: number;
          };
        }
      ).__BUZZ_E2E_THREAD_STATE__;
      return state
        ? {
            anchorId: state.clickAnchorId,
            topOffsetPx: state.clickTopOffsetPx,
            scrollDelta:
              state.clickScrollTop === null
                ? Number.POSITIVE_INFINITY
                : state.clickScrollTop - state.scrollTop,
          }
        : null;
    });
    expect(clickState?.anchorId).not.toBeNull();
    expect(clickState?.topOffsetPx).not.toBeNull();
    expect(Math.abs(clickState?.scrollDelta ?? Number.POSITIVE_INFINITY)).toBe(
      0,
    );
    await expect(page.getByTestId("workspace-focus-thread-pane")).toBeVisible();
    await expect(page.getByTestId("focus-thread-drawer")).toHaveCount(0);
    const workspaceWebTab = page.getByRole("tab", {
      name: "docs.example.com",
    });
    await expect(workspaceWebTab).toBeVisible();
    const workspaceTabTestId = await workspaceWebTab
      .locator("..")
      .getAttribute("data-testid");
    expect(workspaceTabTestId).not.toBeNull();
    await expect(page.getByTestId("workspace-web-url")).toHaveValue(
      workspaceUrl,
    );
    await expect(
      page
        .getByTestId("thread-surface-content")
        .locator(":scope > [data-testid='message-thread-panel']"),
    ).toBeVisible();
    await expect(threadInput).toHaveText(draft);
    const readPreservedThreadState = () =>
      threadSurface.evaluate((surface) => {
        const state = (
          window as Window & {
            __BUZZ_E2E_THREAD_STATE__?: {
              body: HTMLElement;
              clickAnchorId: string | null;
              clickScrollTop: number | null;
              clickTopOffsetPx: number | null;
              input: HTMLElement;
              scrollTop: number;
            };
          }
        ).__BUZZ_E2E_THREAD_STATE__;
        const body = surface.querySelector<HTMLElement>(
          '[data-testid="message-thread-body"]',
        );
        const input = surface.querySelector<HTMLElement>(
          '[data-testid="message-input"]',
        );
        const bodyTop = body?.getBoundingClientRect().top ?? 0;
        const anchor = body
          ? Array.from(
              body.querySelectorAll<HTMLElement>("[data-message-id]"),
            ).find((row) => row.getBoundingClientRect().bottom > bodyTop)
          : undefined;
        return {
          anchor: state?.clickAnchorId === anchor?.dataset.messageId,
          body: state?.body === body,
          input: state?.input === input,
          offsetDelta:
            anchor && state?.clickTopOffsetPx !== null
              ? anchor.getBoundingClientRect().top -
                bodyTop -
                state.clickTopOffsetPx
              : Number.POSITIVE_INFINITY,
          scrollTop: body?.scrollTop ?? 0,
        };
      });
    await expect.poll(readPreservedThreadState).toMatchObject({
      anchor: true,
      body: true,
      input: true,
    });
    const preservedDom = await readPreservedThreadState();
    expect(Math.abs(preservedDom.offsetDelta)).toBeLessThanOrEqual(2);
    expect(preservedDom.scrollTop).toBeGreaterThan(0);

    await page
      .getByRole("button", {
        name: /Back to conversation|Collapse workspace/,
      })
      .click();
    await expect(page.getByTestId("focus-thread-drawer")).toBeVisible();
    await expect(
      page
        .getByTestId("thread-surface-content")
        .locator(":scope > [data-testid='message-thread-panel']"),
    ).toHaveCount(0);
    await expect(page.getByTestId("channel-drop-zone")).toHaveAttribute(
      "inert",
    );
    await expect(threadInput).toHaveText(draft);
    await expect.poll(readPreservedThreadState).toMatchObject({
      anchor: true,
      body: true,
      input: true,
    });
    expect(
      Math.abs((await readPreservedThreadState()).offsetDelta),
    ).toBeLessThanOrEqual(2);

    await page
      .getByRole("button", { name: "Show thread beside channel" })
      .click();
    await expect(page.getByTestId("focus-thread-drawer")).toHaveCount(0);
    await expect(page.getByTestId("channel-drop-zone")).not.toHaveAttribute(
      "inert",
    );
    await expect(threadInput).toHaveText(draft);
    await expect.poll(readPreservedThreadState).toMatchObject({
      anchor: true,
      body: true,
      input: true,
    });
    expect(
      Math.abs((await readPreservedThreadState()).offsetDelta),
    ).toBeLessThanOrEqual(2);

    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("workspace-focus-thread-pane")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(1);
    const reopenedWorkspaceWebTab = page.getByRole("tab", {
      name: "docs.example.com",
    });
    await expect(reopenedWorkspaceWebTab).toBeVisible();
    await expect(reopenedWorkspaceWebTab.locator("..")).toHaveAttribute(
      "data-testid",
      workspaceTabTestId ?? "",
    );
    await expect(page.getByTestId("workspace-web-url")).toHaveValue(
      workspaceUrl,
    );
    await expect(threadInput).toHaveText(draft);
    await expect.poll(readPreservedThreadState).toMatchObject({
      anchor: true,
      body: true,
      input: true,
    });
    expect(
      Math.abs((await readPreservedThreadState()).offsetDelta),
    ).toBeLessThanOrEqual(2);
  });

  test("resizes and resets the shared focus split", async ({ page }) => {
    await emitThreadReply(page);
    await page.getByTestId("message-thread-summary").first().click();
    await expect(page.getByTestId("message-thread-panel")).toBeVisible();
    await page.getByTestId("channel-workspace-toggle").click();
    const thread = page.getByTestId("workspace-focus-thread-pane");
    const pane = page.getByTestId("channel-workspace-pane");
    const handle = page.getByRole("separator", {
      name: /Resize thread context/,
    });
    const before = await thread.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();

    const handleX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
    const handleY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX + 120, handleY);
    await page.mouse.up();

    const resized = await thread.boundingBox();
    expect((resized?.width ?? 0) - (before?.width ?? 0)).toBeGreaterThan(100);

    await handle.dblclick();
    const resetThread = await thread.boundingBox();
    const resetWorkspace = await pane.boundingBox();
    const resetFocusWidth =
      (resetThread?.width ?? 0) + (resetWorkspace?.width ?? 0);
    expect(
      Math.abs(
        (resetThread?.width ?? 0) - expectedFocusThreadWidth(resetFocusWidth),
      ),
    ).toBeLessThanOrEqual(16);

    await handle.focus();
    const beforeKeyboard = await thread.boundingBox();
    await handle.press("ArrowRight");
    const afterKeyboard = await thread.boundingBox();
    expect(
      (afterKeyboard?.width ?? 0) - (beforeKeyboard?.width ?? 0),
    ).toBeGreaterThanOrEqual(15);

    await handle.press("Home");
    const homeThread = await thread.boundingBox();
    const homeWorkspace = await pane.boundingBox();
    const homeFocusWidth =
      (homeThread?.width ?? 0) + (homeWorkspace?.width ?? 0);
    expect(
      Math.abs(
        (homeThread?.width ?? 0) - expectedFocusThreadWidth(homeFocusWidth),
      ),
    ).toBeLessThanOrEqual(16);
  });

  test("closing the last tab closes the workspace pane", async ({ page }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByRole("button", { name: "Close Untitled" }).click();

    await expect(page.getByTestId("channel-workspace-pane")).toHaveCount(0);
    await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
  });

  test("creating a scratchpad tab opens a body and a strip entry", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const body = page.getByTestId("workspace-scratchpad-body");
    await expect(body).toBeVisible();
    await body.fill("workspace notes for #general");

    await expect(page.getByTestId("workspace-tab-strip")).toBeVisible();
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/02-scratchpad-tab.png",
    });
  });

  test("two tabs share one strip with no nesting", async ({ page }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();

    const strips = page.getByTestId("workspace-tab-strip");
    await expect(strips).toHaveCount(1, "there is exactly one tab strip");
    await expect(page.getByRole("tab")).toHaveCount(2);

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/03-two-tabs.png",
    });
  });

  test("the workspace session survives leaving and returning to the channel", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-scratchpad-body").fill("kept");
    await page.getByRole("button", { name: "Collapse workspace" }).click();

    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("channel-workspace")).toHaveCount(
      0,
      "workspace mode is per channel, so #random opens on its timeline",
    );

    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("workspace-scratchpad-body")).toHaveValue(
      "kept",
    );
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/04-restored.png",
    });
  });
});
