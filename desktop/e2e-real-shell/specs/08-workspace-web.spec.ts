// Flow 08: the smallest proof that needs the packaged macOS boundary.
//
// No mock bridge participates. The signed Tauri bundle invokes the native Web
// manager, launches an owned headless Chromium, and renders one real
// Page.startScreencast frame. Engine input belongs in the Chromium/WebKit
// Playwright pair; PID/profile cleanup belongs in Rust lifecycle tests.
import { browser, expect } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";

import {
  clickTestId,
  fillTestId,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { ensureJoinedCommunity } from "../helpers/community";
import { recordResult } from "../helpers/results";
import { startWebFixture, type WebFixture } from "../helpers/web-fixture";

const RELAY_A = process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3040";
const FEATURE_OVERRIDES_KEY = "buzz-feature-overrides-v1";

async function enableWebPreview(): Promise<void> {
  await waitForFirstPaint();
  await browser.execute((storageKey) => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ workspaceWebTab: true }),
    );
  }, FEATURE_OVERRIDES_KEY);
  await browser.refresh();
  await waitForFirstPaint();
}

async function openWorkspace(): Promise<void> {
  await clickTestId("channel-general", 120_000);
  const toggle = await $('[data-testid="channel-workspace-toggle"]');
  await toggle.waitForDisplayed({ timeout: 60_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await waitForTestId("channel-workspace", 30_000);
  await waitForTestId("workspace-new-tab-page", 30_000);
}

async function runningWebBody(): Promise<ChainablePromiseElement> {
  const body = await $('[data-testid="workspace-web-body"]');
  await body.waitForDisplayed({ timeout: 120_000 });
  try {
    await browser.waitUntil(
      async () => (await body.getAttribute("data-status")) === "running",
      { timeout: 120_000, timeoutMsg: "Web CDP session never reached running" },
    );
  } catch (cause) {
    const nativeError = await $('[data-testid="workspace-web-error"]')
      .getText()
      .catch(() => "");
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}${
        nativeError ? `; native error: ${nativeError}` : ""
      }`,
    );
  }
  return body;
}

async function renderPackagedFrame(fixture: WebFixture): Promise<number> {
  await clickTestId("workspace-create-web", 60_000);
  await fillTestId("workspace-web-url", fixture.url, 60_000);
  await clickTestId("workspace-web-navigate", 60_000);

  await runningWebBody();
  const frame = await $('[data-testid="workspace-web-frame"]');
  await frame.waitForDisplayed({ timeout: 30_000 });
  await browser.waitUntil(
    async () => {
      if (!fixture.loaded()) return false;
      const source = (await frame.getAttribute("src")) ?? "";
      if (source.length <= 200) return false;
      return browser.execute((selector) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        if (
          !image?.complete ||
          image.naturalWidth < 16 ||
          image.naturalHeight < 16
        ) {
          return false;
        }
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d");
        if (!context) return false;
        context.drawImage(image, 8, 8, 1, 1, 0, 0, 1, 1);
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
        return (
          red > 20 &&
          red < 50 &&
          green > 175 &&
          green < 220 &&
          blue > 70 &&
          blue < 115 &&
          alpha === 255
        );
      }, '[data-testid="workspace-web-frame"]');
    },
    {
      timeout: 30_000,
      timeoutMsg:
        "fixture loaded but its green proof pixel never reached the CDP frame",
    },
  );

  const surface = await $('[data-testid="workspace-web-surface"]');
  await browser.waitUntil(
    async () => {
      const [frameSize, surfaceSize] = await Promise.all([
        frame.getSize(),
        surface.getSize(),
      ]);
      return (
        Math.abs(frameSize.width - surfaceSize.width) <= 2 &&
        Math.abs(frameSize.height - surfaceSize.height) <= 2
      );
    },
    {
      timeout: 30_000,
      timeoutMsg: "CDP frame did not fill the workspace browser surface",
    },
  );

  expect(await $('[data-testid="workspace-web-toolbar"]').isDisplayed()).toBe(
    true,
  );
  expect(await $('[data-testid="workspace-web-endpoint"]').isDisplayed()).toBe(
    false,
  );
  return ((await frame.getAttribute("src")) ?? "").length;
}

describe("08 packaged workspace Web tab", () => {
  it("renders one real CDP frame through packaged Tauri IPC", async () => {
    const fixture = await startWebFixture();
    try {
      await enableWebPreview();
      await ensureJoinedCommunity(RELAY_A);
      await openWorkspace();

      const frameBytes = await renderPackagedFrame(fixture);
      await browser.saveScreenshot("./e2e-real-shell/results/08-web.png");

      recordResult(
        "08-workspace-web",
        "pass",
        `fixture=${fixture.url} frameBytes=${String(frameBytes)}`,
      );
    } catch (cause: unknown) {
      recordResult(
        "08-workspace-web",
        "fail",
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    } finally {
      await fixture.close();
    }
  });
});
