import { expect, test, type Page } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { readThemeColor } from "../helpers/workspaceAppearance";

const PATTERNS = ["soft-mesh", "diagonal-wash", "halo"] as const;
const ACCENTS = ["violet", "pink", "green"] as const;
const ROOT_TEXT =
  "A readable workspace keeps the channel and its replies together.";

async function openAppearance(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-appearance").click();
  await expect(page.getByTestId("settings-theme")).toBeVisible();
}

async function openPopulatedThread(page: Page) {
  await page.getByTestId("channel-general").click();
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
  const rootId = await page.evaluate((content) => {
    const createdAt = Math.floor(Date.now() / 1000);
    const root = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content,
      createdAt,
    });
    if (!root)
      throw new Error("Workspace appearance root fixture was not created");
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content:
        "The reply stays beside its channel while the colours change. This is sample conversation content for the appearance check.",
      createdAt: createdAt + 1,
      parentEventId: root.id,
    });
    return root.id;
  }, ROOT_TEXT);
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
    )
    .click();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
  return rootId;
}

async function expectNativeSplit(page: Page, rootId: string) {
  const channel = page.getByTestId("channel-drop-zone");
  const thread = page.getByTestId("message-thread-panel");
  const frame = page.locator(
    '.colony-thread-surface[data-thread-mode="split"]',
  );
  await expect(
    page.getByRole("img", { name: "Colony", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your workspace", { exact: true })).toBeVisible();
  await expect(frame).toHaveCSS("border-top-width", "1px");
  await expect(channel).toHaveCSS("border-top-width", "1px");
  await expect(channel).toBeVisible();
  await expect(channel).not.toHaveAttribute("inert", "");
  await expect(thread).toBeVisible();
  await expect(thread.getByTestId("message-thread-head")).toContainText(
    ROOT_TEXT,
  );
  await expect(channel.locator(`[data-message-id="${rootId}"]`)).toBeVisible();
  await expect(
    page.getByTestId("right-auxiliary-pane-resize-handle"),
  ).toBeVisible();
  const channelBox = await channel.boundingBox();
  const threadBox = await thread.boundingBox();
  expect(channelBox).not.toBeNull();
  expect(threadBox).not.toBeNull();
  if (!channelBox || !threadBox)
    throw new Error("Native split pane geometry is missing");
  expect(channelBox.width).toBeGreaterThanOrEqual(300);
  expect(threadBox.width).toBeGreaterThanOrEqual(300);
  expect(threadBox.x).toBeGreaterThanOrEqual(
    channelBox.x + channelBox.width + 8,
  );
  const chromeBox = await page.getByTestId("app-top-chrome").boundingBox();
  expect(channelBox.y).toBeLessThan(
    (chromeBox?.y ?? 0) + (chromeBox?.height ?? 0),
  );
}

test.describe("Colony pane geometry", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      localStorage.setItem("buzz-theme", "buzz");
      localStorage.setItem("buzz-follow-system", "false");
      localStorage.setItem("buzz.channels.threadViewMode", "split");
      sessionStorage.setItem("buzz.desktop.thread-panel-width", "800");
    });
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
  });

  test("workspace and thread fit inside their container without clipping", async ({
    page,
  }) => {
    await openPopulatedThread(page);
    await page.getByTestId("channel-workspace-toggle").click();
    const workspace = page.getByTestId("channel-workspace-pane");
    const thread = page.getByTestId("workspace-focus-thread-pane");
    await expect(workspace).toBeVisible();
    await expect(thread).toBeVisible();
    await expect(page.getByTestId("channel-drop-zone")).toBeHidden();
    await expect
      .poll(() =>
        workspace.evaluate((pane) => {
          const outer = pane.parentElement?.getBoundingClientRect();
          return outer ? pane.getBoundingClientRect().right - outer.right : 999;
        }),
      )
      .toBeLessThanOrEqual(1);
    const threadBox = await thread.boundingBox();
    const workspaceBox = await workspace.boundingBox();
    expect(threadBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(
      Math.abs(
        (workspaceBox?.x ?? 0) -
          ((threadBox?.x ?? 0) + (threadBox?.width ?? 0)),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("a wide profile panel preserves the channel minimum width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 960, height: 960 });
    await page.getByTestId("channel-general").click();
    await page.getByTestId("message-author").first().click();
    await expect(page.getByTestId("user-profile-panel")).toBeVisible();
    await expect(page.getByTestId("message-thread-panel")).toHaveCount(0);
    await expect
      .poll(async () => {
        const box = await page.getByTestId("channel-drop-zone").boundingBox();
        return box?.width ?? 0;
      })
      .toBeGreaterThanOrEqual(300);
  });
});

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: saved background and accent update both native conversation panes`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript((initialMode) => {
      // Seed once: a reload must recover the user's changes rather than replay
      // the test defaults. Relay/native data below is synthetic mock-bridge data.
      if (localStorage.getItem("workspace-appearance-fixture-initialized"))
        return;
      localStorage.setItem("workspace-appearance-fixture-initialized", "true");
      localStorage.setItem(
        "buzz-theme",
        initialMode === "dark" ? "buzz-dark" : "buzz",
      );
      localStorage.setItem("buzz-follow-system", "false");
      localStorage.setItem("buzz-accent-color", "#895AF6");
      localStorage.setItem("buzz-workspace-gradient", "soft-mesh");
      localStorage.setItem("buzz.channels.threadViewMode", "split");
    }, mode);
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const rootId = await openPopulatedThread(page);
    await expectNativeSplit(page, rootId);
    // New workspaces split available reading space evenly. A user resize wins
    // until they explicitly reset it, including through an Appearance change.
    const resizeHandle = page.getByTestId("right-auxiliary-pane-resize-handle");
    const initialFrame = await page
      .locator('.colony-thread-surface[data-thread-mode="split"]')
      .boundingBox();
    expect(initialFrame?.width).toBeGreaterThan(500);
    const handleBox = await resizeHandle.boundingBox();
    if (!handleBox) throw new Error("Thread resize handle has no geometry");
    await page.mouse.move(handleBox.x + handleBox.width - 2, handleBox.y + 180);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 35, handleBox.y + 180);
    await page.mouse.up();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Number(sessionStorage.getItem("buzz.desktop.thread-panel-width")),
        ),
      )
      .toBeGreaterThan(initialFrame?.width ?? 0);
    await resizeHandle.dblclick({ position: { x: 10, y: 180 } });
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem("buzz.desktop.thread-panel-width"),
        ),
      )
      .toBeNull();

    await page.setViewportSize({ width: 860, height: 960 });
    // ResizeObserver switches this width to a standalone thread. Sampling
    // channel visibility once can race that update and then measure a removed
    // channel as zero forever. Wait for the intended narrow layout instead.
    await expect(page.getByTestId("channel-drop-zone")).toHaveCount(0);
    const narrowThread = page.getByTestId("message-thread-panel");
    await expect(narrowThread).toBeVisible();
    await expect
      .poll(async () => (await narrowThread.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(300);
    await page.setViewportSize({ width: 1440, height: 960 });
    await expectNativeSplit(page, rootId);

    const channel = page.getByTestId("channel-drop-zone");
    const thread = page.getByTestId("message-thread-panel");
    await channel.getByTestId("message-input").fill("Channel draft stays here");
    await thread.getByTestId("message-input").fill("Thread draft stays here");
    const paneColours = new Set<string>();
    const panePatterns = new Set<string>();
    for (const accent of ACCENTS) {
      await openAppearance(page);
      await page.getByTestId(`accent-color-${accent}`).click();
      const paintedPatterns = new Set<string>();
      for (const pattern of PATTERNS) {
        const button = page.getByTestId(`workspace-pattern-${pattern}`);
        await button.focus();
        await button.press("Enter");
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("html")).toHaveAttribute(
          "data-workspace-gradient",
          pattern,
        );
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem("buzz-workspace-gradient"),
            ),
          )
          .toBe(pattern);
        paintedPatterns.add(
          await page
            .locator(`[data-buzz-gradient="${mode}"]`)
            .evaluate((element) => getComputedStyle(element).backgroundImage),
        );
      }
      expect(paintedPatterns.size).toBe(3);
      await waitForAnimations(page);
      if (accent === "violet") {
        await page.getByTestId("settings-theme").screenshot({
          path: `test-results/workspace-appearance/${mode}-appearance.png`,
        });
      }
      await page.getByTestId("settings-back-to-app").click();
      await expect(page.getByTestId("settings-view")).toHaveCount(0);
      await expectNativeSplit(page, rootId);
      await expect(channel.getByTestId("message-input")).toHaveText(
        "Channel draft stays here",
      );
      await expect(thread.getByTestId("message-input")).toHaveText(
        "Thread draft stays here",
      );

      const contentColour = await readThemeColor(
        page,
        `hsl(var(--buzz-workspace-${mode}-content))`,
      );
      const raisedColour = await readThemeColor(
        page,
        `hsl(var(--buzz-workspace-${mode}-raised))`,
      );
      expect(contentColour).toMatch(/^rgb\(/);
      await expect(channel).toHaveCSS("background-color", contentColour);
      const threadSurface = page
        .locator(".colony-thread-surface")
        .filter({ has: thread });
      await expect(threadSurface).toHaveCSS("background-color", contentColour);
      const channelPattern = await channel.evaluate(
        (element) => getComputedStyle(element).backgroundImage,
      );
      expect(channelPattern).not.toBe("none");
      await expect(threadSurface).toHaveCSS("background-image", channelPattern);
      paneColours.add(contentColour);
      panePatterns.add(channelPattern);
      for (const overlayId of [
        "channel-composer-overlay",
        "thread-composer-overlay",
      ]) {
        const overlay = page.getByTestId(overlayId);
        expect(
          await overlay.evaluate(
            (element) => getComputedStyle(element, "::after").backgroundColor,
          ),
        ).toBe(contentColour);
        await expect(overlay.getByTestId("message-composer")).toHaveCSS(
          "background-color",
          raisedColour,
        );
      }
      await waitForAnimations(page);
      await page.screenshot({
        path: `test-results/workspace-appearance/${mode}-${accent}-split.png`,
      });
    }
    expect(paneColours.size).toBe(3);
    expect(panePatterns.size).toBe(3);

    // Wait for the local community record, so the reload covers the same
    // persisted path as a user returning to this workspace.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith("buzz-community-theme.v2:"))
            .some((key) => {
              const value = JSON.parse(localStorage.getItem(key) ?? "null");
              return (
                value?.gradientPattern === "halo" && value?.accent === "#22c55e"
              );
            }),
        ),
      )
      .toBe(true);
    const communityId = await page
      .getByTestId("community-lifecycle-marker")
      .getAttribute("data-community-id");
    expect(communityId).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    // DOMContentLoaded can expose a temporary shell before the saved community
    // and channel have finished restoring. Opening its menu races the remount.
    const lifecycle = page.getByTestId("community-lifecycle-marker");
    await expect(lifecycle).toHaveAttribute(
      "data-community-id",
      communityId ?? "",
    );
    await expect(lifecycle).toHaveAttribute("data-community-state", "ready");
    await expect(page.getByTestId("chat-title")).toHaveText("general");
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
    await expect(page.getByTestId("boot-splash-overlay")).toHaveCount(0);
    await openAppearance(page);
    await expect(page.getByTestId("workspace-pattern-halo")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("accent-color-green")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId(`appearance-mode-${mode}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-workspace-gradient",
      "halo",
    );
  });
}
