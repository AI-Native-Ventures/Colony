import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

async function emitThreadReply(page: import("@playwright/test").Page) {
  await page.evaluate(
    ({ pubkey }) =>
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            parentEventId: string;
            pubkey: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Thread reply for dock ordering",
        parentEventId: "mock-general-welcome",
        pubkey,
      }),
    { pubkey: TEST_IDENTITIES.alice.pubkey },
  );
}

test.describe("channel workspace", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
  });

  test("docks the workspace to the right of the live channel", async ({
    page,
  }) => {
    const toggle = page.getByTestId("channel-workspace-toggle");
    await expect(toggle).toBeVisible();

    await expect(page.getByTestId("channel-workspace")).toHaveCount(0);
    await toggle.click();

    const workspace = page.getByTestId("channel-workspace");
    await expect(workspace).toBeVisible();
    await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
    await expect(page.getByTestId("message-input")).toBeVisible();

    const channelBox = await page
      .getByTestId("channel-drop-zone")
      .boundingBox();
    const workspaceBox = await workspace.boundingBox();
    expect(channelBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect((channelBox?.x ?? 0) + (channelBox?.width ?? 0)).toBeLessThanOrEqual(
      workspaceBox?.x ?? 0,
    );

    await waitForAnimations(page);
    await page.getByTestId("channel-drop-zone").locator("..").screenshot({
      path: "test-results/workspace/01-docked-workspace.png",
    });

    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
  });

  test("keeps an open thread between the channel and workspace", async ({
    page,
  }) => {
    await emitThreadReply(page);
    await page.getByTestId("message-thread-summary").first().click();
    await expect(page.getByTestId("message-thread-panel")).toBeVisible();

    await page.getByTestId("channel-workspace-toggle").click();

    const channelBox = await page
      .getByTestId("channel-drop-zone")
      .boundingBox();
    const threadBox = await page
      .getByTestId("message-thread-panel")
      .boundingBox();
    const workspaceBox = await page
      .getByTestId("channel-workspace-pane")
      .boundingBox();
    expect(channelBox).not.toBeNull();
    expect(threadBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect((channelBox?.x ?? 0) + (channelBox?.width ?? 0)).toBeLessThanOrEqual(
      threadBox?.x ?? 0,
    );
    expect((threadBox?.x ?? 0) + (threadBox?.width ?? 0)).toBeLessThanOrEqual(
      workspaceBox?.x ?? 0,
    );

    const threadHandle = page.getByTestId("right-auxiliary-pane-resize-handle");
    const threadHandleBox = await threadHandle.boundingBox();
    expect(threadHandleBox).not.toBeNull();
    const handleX =
      (threadHandleBox?.x ?? 0) + (threadHandleBox?.width ?? 0) / 2;
    const handleY =
      (threadHandleBox?.y ?? 0) + (threadHandleBox?.height ?? 0) / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX + 60, handleY);
    await page.mouse.up();

    const resizedThreadBox = await page
      .getByTestId("message-thread-panel")
      .boundingBox();
    const stableWorkspaceBox = await page
      .getByTestId("channel-workspace-pane")
      .boundingBox();
    expect(
      (threadBox?.width ?? 0) - (resizedThreadBox?.width ?? 0),
    ).toBeGreaterThan(40);
    expect(stableWorkspaceBox?.width).toBe(workspaceBox?.width);

    await waitForAnimations(page);
    await page.getByTestId("channel-drop-zone").locator("..").screenshot({
      path: "test-results/workspace/05-channel-thread-workspace.png",
    });
  });

  test("resizes the workspace without collapsing the channel", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    const pane = page.getByTestId("channel-workspace-pane");
    const handle = page.getByTestId("workspace-pane-resize-handle");
    const before = await pane.boundingBox();
    const handleBox = await handle.boundingBox();
    expect(before).not.toBeNull();
    expect(handleBox).not.toBeNull();

    const handleX = (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2;
    const handleY = (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2;
    await page.mouse.move(handleX, handleY);
    await page.mouse.down();
    await page.mouse.move(handleX - 120, handleY);
    await page.mouse.up();

    const after = await pane.boundingBox();
    const channel = await page.getByTestId("channel-drop-zone").boundingBox();
    expect((after?.width ?? 0) - (before?.width ?? 0)).toBeGreaterThan(100);
    expect(channel?.width ?? 0).toBeGreaterThanOrEqual(300);
  });

  test("fullscreen round trip restores the same docked layout", async ({
    page,
  }) => {
    await emitThreadReply(page);
    await page.getByTestId("message-thread-summary").first().click();
    const thread = page.getByTestId("message-thread-panel");
    await expect(thread).toBeVisible();
    await page.getByTestId("channel-workspace-toggle").click();
    const pane = page.getByTestId("channel-workspace-pane");
    const before = await pane.boundingBox();
    const threadBefore = await thread.boundingBox();

    await page.getByTestId("workspace-expand-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toBeHidden();
    await expect(page.getByTestId("channel-drop-zone")).toBeHidden();
    await expect(thread).toBeHidden();
    await expect(pane).toBeVisible();

    await page.getByTestId("workspace-expand-toggle").click();
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
    await expect(thread).toBeVisible();
    const after = await pane.boundingBox();
    const threadAfter = await thread.boundingBox();
    expect(after?.width).toBe(before?.width);
    expect(threadAfter?.width).toBe(threadBefore?.width);
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

  test("the workspace survives leaving and returning to the channel", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByTestId("workspace-scratchpad-body").fill("kept");

    await page.getByTestId("channel-random").click();
    await expect(page.getByTestId("channel-workspace")).toHaveCount(
      0,
      "workspace mode is per channel, so #random opens on its timeline",
    );

    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("workspace-scratchpad-body")).toHaveValue(
      "kept",
    );
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace/04-restored.png",
    });
  });
});
