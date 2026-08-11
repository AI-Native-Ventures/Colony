// Engine-level input contract for the Web workspace tab.
//
// This spec runs in BOTH Chromium and WebKit. WebKit is the engine behind the
// packaged macOS WKWebView, so browser-specific input quirks (compatibility
// mouse events without pointer events, wheel delivery, Enter-to-submit) surface
// here in seconds instead of after a 20-minute packaged Tauri rebuild.
//
// Everything below uses REAL driver input (page.mouse / page.keyboard), never
// dispatchEvent: a synthetic event proves the handler runs, not that the engine
// delivers the event the handler is bound to. That distinction is the entire
// point of this file.
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type WebInput = {
  deltaX?: number;
  eventType?: string;
  x?: number;
  y?: number;
  text?: string;
  deltaY?: number;
};
type LoggedCommand = {
  command: string;
  completedAtMs?: number;
  payload: { input?: WebInput };
};

async function commands(page: Page): Promise<LoggedCommand[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_WEB_COMMANDS__?: () => LoggedCommand[];
        }
      ).__BUZZ_E2E_WEB_COMMANDS__?.() ?? [],
  );
}

/** Polls until at least one `name` command is logged, then returns them all. */
async function commandsNamed(
  page: Page,
  name: string,
): Promise<LoggedCommand[]> {
  const matching = async (): Promise<LoggedCommand[]> =>
    (await commands(page)).filter((entry) => entry.command === name);
  await expect
    .poll(async () => (await matching()).length, {
      message: `no ${name} command reached the bridge`,
    })
    .toBeGreaterThan(0);
  return matching();
}

async function resizeCommandCount(page: Page): Promise<number> {
  return (await commands(page)).filter(
    (entry) => entry.command === "workspace_web_resize",
  ).length;
}

async function openWebTab(page: Page): Promise<void> {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.getByTestId("channel-workspace-toggle").click();
  await page.getByTestId("workspace-create-web").click();
  await page.getByTestId("workspace-web-url").fill("http://127.0.0.1:8778");
}

/** Opens a web tab and drives it to a rendered screencast frame. */
async function runningFrame(page: Page): Promise<{ x: number; y: number }> {
  await openWebTab(page);
  await page.getByTestId("workspace-web-navigate").click();
  const frame = page.getByTestId("workspace-web-frame");
  await expect(frame).toBeVisible();
  const box = await frame.boundingBox();
  if (!box) throw new Error("screencast frame has no layout box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("web workspace input contract", () => {
  test("submits the URL bar from a real Enter key", async ({ page }) => {
    await openWebTab(page);
    // The packaged harness could not do this through WebDriver, so the journey
    // was rerouted through the Go button. A real engine key press is the honest
    // check that the form itself submits.
    await page.getByTestId("workspace-web-url").press("Enter");

    await expect(page.getByTestId("workspace-web-body")).toHaveAttribute(
      "data-status",
      "running",
    );
    await commandsNamed(page, "workspace_web_start");
  });

  test("forwards real mouse input from the screencast surface", async ({
    page,
  }) => {
    const centre = await runningFrame(page);
    // A real click at the visual centre of the frame. On WebKit this delivers
    // mousedown/mouseup without pointerdown, which is exactly how the packaged
    // app silently dropped every click.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.up();

    const mouse = await commandsNamed(page, "workspace_web_mouse");
    const types = mouse.map((entry) => entry.payload.input?.eventType);
    expect(types).toContain("mouseMoved");
    expect(types).toContain("mousePressed");
    expect(types).toContain("mouseReleased");

    // Coordinates must be translated into the remote page's own space, not
    // passed through as app-window coordinates.
    for (const entry of mouse) {
      const input = entry.payload.input;
      expect(typeof input?.x).toBe("number");
      expect(typeof input?.y).toBe("number");
      expect(input?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect(input?.y ?? -1).toBeGreaterThanOrEqual(0);
    }
  });

  // Regression guard for the window-level scroll boundary lock. That listener
  // runs at window capture with `passive: false` and consumes any wheel whose
  // event path holds no scrollable element. The screencast surface is
  // deliberately `overflow-hidden`, so it matched that rule and every wheel was
  // preventDefault'd and stopPropagation'd before React's onWheel could run —
  // in every environment, not just the packaged app.
  test("forwards real wheel input from the screencast surface", async ({
    page,
  }) => {
    const centre = await runningFrame(page);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, 120);

    const wheel = await commandsNamed(page, "workspace_web_wheel");
    expect(wheel[0]?.payload.input?.deltaY ?? 0).toBeGreaterThan(0);
  });

  test("bounds burst wheel latency", async ({ page }) => {
    const centre = await runningFrame(page);
    await page.evaluate(() => {
      window.__BUZZ_E2E_WEB_PERFORMANCE__?.setWheelDelay(25);
    });
    const startedAtMs = await page.evaluate(() => performance.now());
    await page.mouse.move(centre.x, centre.y);
    for (let index = 0; index < 12; index += 1) {
      await page.mouse.wheel(3, 24);
    }
    const inputFinishedAtMs = await page.evaluate(() => performance.now());

    await expect
      .poll(async () => {
        const wheel = (await commands(page)).filter(
          (entry) => entry.command === "workspace_web_wheel",
        );
        return wheel.reduce(
          (sum, entry) => sum + (entry.payload.input?.deltaY ?? 0),
          0,
        );
      })
      .toBe(288);

    const wheel = (await commands(page)).filter(
      (entry) => entry.command === "workspace_web_wheel",
    );
    const settledAtMs = Math.max(
      ...wheel.map((entry) => entry.completedAtMs ?? startedAtMs),
    );
    const endToEndLatencyMs = settledAtMs - startedAtMs;
    const tailLatencyMs = settledAtMs - inputFinishedAtMs;
    const deltaX = wheel.reduce(
      (sum, entry) => sum + (entry.payload.input?.deltaX ?? 0),
      0,
    );
    const performanceSnapshot = await page.evaluate(() =>
      window.__BUZZ_E2E_WEB_PERFORMANCE__?.snapshot(),
    );
    console.log(
      `web wheel burst: commands=${wheel.length} maxPending=${performanceSnapshot?.maxPendingWheelInvocations ?? -1} endToEndMs=${endToEndLatencyMs.toFixed(1)} tailMs=${tailLatencyMs.toFixed(1)} deltaX=${deltaX}`,
    );
    expect(deltaX).toBe(36);
    expect(performanceSnapshot?.maxPendingWheelInvocations).toBe(1);
    expect(tailLatencyMs).toBeLessThan(100);
  });

  test("publishes only the newest frame from a burst", async ({ page }) => {
    await runningFrame(page);
    const frame = page.getByTestId("workspace-web-frame");
    const mutations = await frame.evaluate(async (element) => {
      let count = 0;
      const observer = new MutationObserver(() => {
        count += 1;
      });
      observer.observe(element, {
        attributeFilter: ["data-frame-scroll-y"],
      });
      await window.__BUZZ_E2E_WEB_PERFORMANCE__?.emitFrameBurst(12);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      observer.disconnect();
      return count;
    });
    await expect(frame).toHaveAttribute("data-frame-scroll-y", "12");
    expect(mutations).toBeLessThanOrEqual(1);
  });

  test("forwards real typed text to the remote page", async ({ page }) => {
    await runningFrame(page);
    await page.getByTestId("workspace-web-body").focus();
    await page.keyboard.type("colony-web");

    const keys = await commandsNamed(page, "workspace_web_key");
    const typed = keys
      .map((entry) => entry.payload.input)
      .filter((input) => input?.eventType === "keyDown")
      .map((input) => input?.text ?? "")
      .join("");
    expect(typed).toBe("colony-web");
  });

  // Guards the React ResizeObserver and command sequence in Chromium and
  // WebKit. The mock bridge always emits a fixed 640x360 frame, so this cannot
  // exercise a packaged CDP frame-size feedback loop.
  test("converges after initial and viewport resize events", async ({
    page,
  }) => {
    await runningFrame(page);
    await commandsNamed(page, "workspace_web_resize");

    const settleWindowMs = 1_000;
    const maxResizeBurst = 1;
    const initialCount = await resizeCommandCount(page);
    await page.waitForTimeout(settleWindowMs);
    expect(await resizeCommandCount(page)).toBe(initialCount);

    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(settleWindowMs);
    const afterResizeCount = await resizeCommandCount(page);
    expect(afterResizeCount).toBeGreaterThan(initialCount);
    expect(afterResizeCount - initialCount).toBeLessThanOrEqual(maxResizeBurst);

    await page.waitForTimeout(settleWindowMs);
    expect(await resizeCommandCount(page)).toBe(afterResizeCount);
  });
});
