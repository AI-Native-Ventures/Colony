// Flow 08: prove the packaged Web workspace tab through real Tauri/CDP.
//
// No mock bridge participates: Colony launches an owned headless Chromium,
// renders Page.startScreencast frames, and forwards input through real Tauri
// IPC. Focused native tests cover owned-browser lifecycle reaping.
import { browser, expect } from "@wdio/globals";
import { Key, type ChainablePromiseElement } from "webdriverio";

import {
  clickTestId,
  fillTestId,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { ensureJoinedCommunity } from "../helpers/community";
import { processTree, psFindWhere, waitForPidsGone } from "../helpers/process";
import { recordResult } from "../helpers/results";
import {
  startWebFixture,
  type WebFixture,
  type WebFixturePoint,
  type WebFixtureTargets,
} from "../helpers/web-fixture";

const RELAY_A = process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3040";
const FEATURE_OVERRIDES_KEY = "buzz-feature-overrides-v1";

type FrameMetrics = {
  nativeWidth: number;
  nativeHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  left: number;
  top: number;
};

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

async function webBody(): Promise<ChainablePromiseElement> {
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

async function ownedBrowserPid(body: ChainablePromiseElement): Promise<number> {
  const value = await body.getAttribute("data-browser-pid");
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`owned Web session did not expose a live PID: ${value}`);
  }
  return pid;
}

async function createOwnedWeb(url = "about:blank"): Promise<{
  body: ChainablePromiseElement;
  frame: ChainablePromiseElement;
  pid: number;
}> {
  await clickTestId("workspace-create-web", 60_000);
  await fillTestId("workspace-web-url", url, 60_000);
  // WebKit's global key action does not reliably submit the focused React
  // form in the packaged webview. The visible Go control exercises the same
  // URL-bar submit path without depending on that driver quirk.
  await clickTestId("workspace-web-navigate", 60_000);
  const body = await webBody();
  const frame = await $('[data-testid="workspace-web-frame"]');
  await frame.waitForDisplayed({ timeout: 120_000 });
  await browser.waitUntil(
    async () => ((await frame.getAttribute("src")) ?? "").length > 200,
    { timeout: 60_000, timeoutMsg: "CDP screencast frame remained empty" },
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
  return { body, frame, pid: await ownedBrowserPid(body) };
}

async function frameMetrics(
  frame: ChainablePromiseElement,
): Promise<FrameMetrics> {
  const size = await frame.getSize();
  const location = await frame.getLocation();
  const nativeWidth = Number(await frame.getAttribute("width"));
  const nativeHeight = Number(await frame.getAttribute("height"));
  if (
    nativeWidth <= 0 ||
    nativeHeight <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new Error(
      `invalid Web frame metrics: native=${nativeWidth}x${nativeHeight} rendered=${size.width}x${size.height}`,
    );
  }
  return {
    nativeWidth,
    nativeHeight,
    renderedWidth: size.width,
    renderedHeight: size.height,
    left: location.x,
    top: location.y,
  };
}

function viewportPoint(
  metrics: FrameMetrics,
  pagePoint: WebFixturePoint,
): { x: number; y: number } {
  return {
    x: Math.round(
      metrics.left +
        (pagePoint.x / metrics.nativeWidth) * metrics.renderedWidth,
    ),
    y: Math.round(
      metrics.top +
        (pagePoint.y / metrics.nativeHeight) * metrics.renderedHeight,
    ),
  };
}

async function clickRemote(
  metrics: FrameMetrics,
  point: WebFixturePoint,
): Promise<void> {
  const target = viewportPoint(metrics, point);
  await browser
    .action("pointer")
    .move({ origin: "viewport", x: target.x, y: target.y, duration: 100 })
    .down("left")
    .up("left")
    .perform();
}

async function trackedTree(pid: number, label: string): Promise<number[]> {
  await browser.waitUntil(async () => processTree(pid).length > 0, {
    timeout: 30_000,
    timeoutMsg: `${label} never exposed a Chromium descendant`,
  });
  const descendants = processTree(pid).map((row) => row.pid);
  const tracked = [...new Set([pid, ...descendants])];
  // eslint-disable-next-line no-console
  console.log(`[08] ${label} process tree: ${JSON.stringify(tracked)}`);
  return tracked;
}

async function proveGone(label: string, pids: number[]): Promise<void> {
  const tracked = [...new Set(pids)];
  await waitForPidsGone(tracked, 120_000, label);
  const remaining = psFindWhere((row) => tracked.includes(row.pid));
  expect(remaining).toHaveLength(0);
  // eslint-disable-next-line no-console
  console.log(
    `[08] ${label}: pids=${tracked.join(",")} kill-0=false ps=absent`,
  );
}

async function proveFixtureInput(
  fixture: WebFixture,
  frame: ChainablePromiseElement,
): Promise<void> {
  let previousMetrics: FrameMetrics | null = null;
  let stableSamples = 0;
  let accepted: { metrics: FrameMetrics; targets: WebFixtureTargets } | null =
    null;
  await browser.waitUntil(
    async () => {
      const metrics = await frameMetrics(frame);
      const sameAsPrevious =
        previousMetrics !== null &&
        metrics.nativeWidth === previousMetrics.nativeWidth &&
        metrics.nativeHeight === previousMetrics.nativeHeight &&
        metrics.renderedWidth === previousMetrics.renderedWidth &&
        metrics.renderedHeight === previousMetrics.renderedHeight &&
        metrics.left === previousMetrics.left &&
        metrics.top === previousMetrics.top;
      stableSamples = sameAsPrevious ? stableSamples + 1 : 1;
      previousMetrics = metrics;
      const receipt = fixture.receipts();
      const viewportMatches =
        receipt.targets !== null &&
        receipt.viewport?.width === metrics.nativeWidth &&
        receipt.viewport?.height === metrics.nativeHeight;
      if (viewportMatches && stableSamples >= 2 && receipt.targets !== null) {
        accepted = { metrics, targets: receipt.targets };
        return true;
      }
      return false;
    },
    {
      timeout: 60_000,
      timeoutMsg:
        "fixture never reported target coordinates for a stable current viewport",
    },
  );
  if (!accepted) {
    throw new Error(
      "fixture target coordinates disappeared after stabilization",
    );
  }
  const acceptedResult = accepted as {
    metrics: FrameMetrics;
    targets: WebFixtureTargets;
  };

  await clickRemote(acceptedResult.metrics, acceptedResult.targets.input);
  await browser.waitUntil(() => fixture.receipts().pointerEvents > 0, {
    timeout: 30_000,
    timeoutMsg: "remote input never received the forwarded pointer",
  });
  await browser.execute(() => {
    (
      document.querySelector(
        '[data-testid="workspace-web-body"]',
      ) as HTMLElement | null
    )?.focus();
  });
  await browser.keys("colony-web");

  const frameBeforeAction = await frame.getAttribute("src");
  await browser.keys([Key.Enter]);
  await browser.waitUntil(
    () => fixture.receipts().pass && fixture.receipts().visualPass,
    {
      timeout: 60_000,
      timeoutMsg: `fixture did not reach PASS: ${JSON.stringify(fixture.receipts())}`,
    },
  );
  expect(fixture.receipts().inputValues).toEqual(["colony-web"]);
  expect(fixture.receipts().actions).toBe(1);
  await browser.waitUntil(
    async () => (await frame.getAttribute("src")) !== frameBeforeAction,
    {
      timeout: 30_000,
      timeoutMsg: "PASS state never produced an updated screencast frame",
    },
  );
}

describe("08 packaged workspace Web tab", () => {
  it("renders a real CDP frame and forwards input inside the packaged app", async () => {
    const fixture = await startWebFixture();
    try {
      await enableWebPreview();
      await ensureJoinedCommunity(RELAY_A);
      await openWorkspace();

      // One session only. Tab-close, community-reset, and app-quit reaping are
      // proven in desktop/src-tauri/src/web_lifecycle_tests.rs against a real
      // headless Chromium, which does not need a packaged build and does not
      // flash windows at whoever is watching. What is packaged-only is this:
      // real Tauri IPC inside the signed bundle producing a real CDP frame.
      const session = await createOwnedWeb(fixture.url);
      const tree = await trackedTree(session.pid, "packaged browser");
      await proveFixtureInput(fixture, session.frame);
      await browser.saveScreenshot("./e2e-real-shell/results/08-web.png");

      const tab = await $('[data-testid^="workspace-tab-"]');
      await tab.moveTo();
      const close = await tab.$('button[aria-label="Close Web"]');
      await close.waitForExist({ timeout: 30_000 });
      await close.click();
      // Kept because this run owns these processes and must not leak them,
      // not as the lifecycle proof.
      await proveGone("packaged browser tree", tree);

      recordResult(
        "08-workspace-web",
        "pass",
        `fixture=${fixture.url} browserPid=${session.pid}`,
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
