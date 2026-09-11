import { expect, test, type Locator, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { installTerminalMockBridge } from "../helpers/terminalBridge";

const SHOTS = "test-results/workspace-factory";

type TerminalDims = { cols: number; rows: number } | null;

/**
 * The fitted PTY size the terminal last reported. Read through the seam the
 * terminal spec uses, so a pane that changes width is proven by the columns
 * the terminal actually fitted to rather than by CSS.
 */
async function terminalCols(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_TERMINAL_DIMS__?: () => TerminalDims;
        }
      ).__BUZZ_E2E_TERMINAL_DIMS__?.()?.cols ?? 0,
  );
}

async function waitForTerminalSeam(page: Page): Promise<void> {
  // The e2e bridge installs its globals from a lazily loaded chunk, so the
  // seam can be absent for a few tens of milliseconds. Wait for it here and
  // keep the polls below free of throwing callbacks.
  await page.waitForFunction(
    () =>
      typeof (window as Window & { __BUZZ_E2E_TERMINAL_DIMS__?: unknown })
        .__BUZZ_E2E_TERMINAL_DIMS__ === "function",
  );
  await expect.poll(async () => await terminalCols(page)).toBeGreaterThan(0);
}

/** Open the channel workspace, whatever surface mode the channel was left in. */
async function openWorkspace(page: Page, channelTestId: string): Promise<void> {
  // An open workspace hides the sidebar (AppShell drops it while the
  // workspace owns the content column), so leave it before switching channel.
  const back = page.getByTestId("workspace-back-to-conversation");
  if ((await back.count()) > 0) {
    await back.first().click();
  }
  await page.getByTestId(channelTestId).click();
  const toggle = page.getByTestId("channel-workspace-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("channel-workspace")).toBeVisible();
}

/** The tab row entry for a title inside the factory panes. */
function paneTab(page: Page, title: string): Locator {
  return page
    .locator('[data-testid^="factory-tab-"]')
    .filter({ hasText: title })
    .first();
}

async function box(locator: Locator): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
}> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("element has no bounding box");
  return bounds;
}

/** Press, cross the 6px threshold in steps, and release at the given point. */
async function dragTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  duringDrag?: () => Promise<void>,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / steps,
      from.y + ((to.y - from.y) * step) / steps,
    );
  }
  if (duringDrag) await duringDrag();
  await page.mouse.up();
}

test.describe("factory workspace tab", () => {
  test("is offered only in a project channel", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");

    await openWorkspace(page, "channel-general");
    await expect(page.getByTestId("workspace-create-factory")).toBeVisible();

    await openWorkspace(page, "channel-random");
    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
    // The other kinds are still offered, so this is availability rather than
    // an empty new-tab page.
    await expect(page.getByTestId("workspace-create-scratchpad")).toBeVisible();
    await expect(page.getByTestId("workspace-create-factory")).toHaveCount(0);
  });

  test("tiles workspace tabs, splits on drop, resizes, and persists", async ({
    page,
  }) => {
    await installTerminalMockBridge(page);
    await installMockBridge(page);
    await page.goto("/");
    await openWorkspace(page, "channel-general");

    await page.getByTestId("workspace-create-factory").click();
    const canvas = page.getByTestId("factory-canvas");
    await expect(canvas).toBeVisible();
    const panes = page.getByTestId("factory-pane");
    await expect(panes).toHaveCount(1);

    // Both tabs are created from the strip and adopted by the single pane.
    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-terminal").click();
    await expect(page.getByTestId("workspace-terminal-body")).toBeVisible();
    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByRole("tab", { name: "Factory" }).click();

    await expect(panes).toHaveCount(1);
    await expect(page.locator('[data-testid^="factory-tab-"]')).toHaveCount(2);
    // Tabs a pane owns leave the top strip while the factory tab is active.
    await expect(page.getByRole("tab", { name: "Terminal" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Untitled" })).toHaveCount(0);

    await waitForTerminalSeam(page);
    const colsSinglePane = await terminalCols(page);

    // Drag the scratchpad tab into the right edge band of the only pane.
    const paneBounds = await box(panes.first());
    const tabBounds = await box(paneTab(page, "Untitled"));
    const overlay = page.getByTestId("factory-drop-overlay");
    await dragTo(
      page,
      {
        x: tabBounds.x + tabBounds.width / 2,
        y: tabBounds.y + tabBounds.height / 2,
      },
      {
        x: paneBounds.x + paneBounds.width * 0.85,
        y: paneBounds.y + paneBounds.height * 0.6,
      },
      async () => {
        await expect(overlay).toBeVisible();
        await expect(overlay).toHaveAttribute("data-zone", "right");
      },
    );

    await expect(panes).toHaveCount(2);
    await expect(overlay).toHaveCount(0);
    await expect(page.getByTestId("workspace-terminal-body")).toBeVisible();
    await expect
      .poll(async () => await terminalCols(page))
      .toBeLessThan(colsSinglePane);
    const colsAfterSplit = await terminalCols(page);

    // Both panes fill the canvas: a pane that sizes to its content leaves the
    // canvas half empty and is what the first screenshot caught.
    const canvasHeight = (await box(canvas)).height;
    for (const index of [0, 1]) {
      const paneHeight = (await box(panes.nth(index))).height;
      expect(paneHeight).toBeGreaterThan(canvasHeight - 24);
    }

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: `${SHOTS}/01-factory-mock.png`,
    });

    // Drag the splitter right: the terminal pane grows and refits the PTY.
    const leftWidthBefore = (await box(panes.first())).width;
    const splitter = page.locator('[data-testid^="factory-splitter-"]').first();
    const splitterBounds = await box(splitter);
    await dragTo(
      page,
      {
        x: splitterBounds.x + splitterBounds.width / 2,
        y: splitterBounds.y + splitterBounds.height / 2,
      },
      {
        x: splitterBounds.x + splitterBounds.width / 2 + 200,
        y: splitterBounds.y + splitterBounds.height / 2,
      },
    );
    await expect
      .poll(async () => (await box(panes.first())).width - leftWidthBefore)
      .toBeGreaterThan(170);
    expect((await box(panes.first())).width - leftWidthBefore).toBeLessThan(
      230,
    );
    await expect
      .poll(async () => await terminalCols(page))
      .toBeGreaterThan(colsAfterSplit);

    // Presets rebuild the tree: columns is even, focus is 58/42.
    await page.getByTestId("factory-preset-columns").click();
    await expect(panes).toHaveCount(2);
    await expect
      .poll(async () => {
        const first = (await box(panes.nth(0))).width;
        const second = (await box(panes.nth(1))).width;
        return Math.abs(first - second);
      })
      .toBeLessThan(10);

    await page.getByTestId("factory-preset-focus").click();
    await expect(panes).toHaveCount(2);
    const focusGroup = page.getByTestId("factory-group-preset-focus");
    await expect(focusGroup).toBeVisible();
    await expect
      .poll(async () => {
        const groupWidth = (await box(focusGroup)).width;
        const leftWidth = (await box(panes.nth(0))).width;
        return groupWidth > 0 ? leftWidth / groupWidth : 0;
      })
      .toBeGreaterThan(0.55);
    const focusRatio =
      (await box(panes.nth(0))).width / (await box(focusGroup)).width;
    expect(focusRatio).toBeLessThan(0.61);

    // The layout lives in the tab payload, so a reload restores it. The route
    // and the channel's workspace mode both persist, so the canvas comes back
    // without navigating.
    await page.reload();
    await expect(page.getByTestId("factory-canvas")).toBeVisible();
    await expect(panes).toHaveCount(2);
    await expect
      .poll(async () => {
        const group = page.getByTestId("factory-group-preset-focus");
        const groupWidth = (await group.boundingBox())?.width ?? 0;
        const leftWidth = (await panes.nth(0).boundingBox())?.width ?? 0;
        return groupWidth > 0 ? leftWidth / groupWidth : 0;
      })
      .toBeGreaterThan(0.55);

    // Closing the factory tab hands its tabs back to the top strip.
    await page.getByRole("button", { name: "Close Factory" }).click();
    await expect(page.getByTestId("factory-canvas")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Terminal" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Untitled" })).toBeVisible();
  });
});
