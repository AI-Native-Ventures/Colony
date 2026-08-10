// Flow 08 — prove the packaged Web workspace tab through real Tauri/CDP.
//
// No mock bridge participates: Colony launches an owned headless Chromium,
// renders Page.startScreencast frames, forwards input, and reaps the browser
// process tree on tab close, community reset, and normal app quit.
import { browser, expect } from "@wdio/globals";
import type { ChainablePromiseElement } from "webdriverio";

import {
  clickTestId,
  fillTestId,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { ensureJoinedCommunity } from "../helpers/community";
import {
  processTree,
  psFindWhere,
  waitForPidsGone,
  waitForProcessWhere,
} from "../helpers/process";
import { recordResult } from "../helpers/results";
import {
  startWebFixture,
  type WebFixture,
  type WebFixturePoint,
} from "../helpers/web-fixture";

const RELAY_A = process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3040";
const RELAY_B = RELAY_A.replace("localhost", "127.0.0.1");
const FEATURE_OVERRIDES_KEY = "buzz-feature-overrides-v1";

type PersistedCommunity = {
  id: string;
  relayUrl: string;
};

type PersistedCommunityState = {
  activeId: string | null;
  communities: PersistedCommunity[];
};

type FrameMetrics = {
  element: ChainablePromiseElement;
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
  await clickTestId("workspace-web-connect", 60_000);
  const body = await webBody();
  const frame = await $('[data-testid="workspace-web-frame"]');
  await frame.waitForDisplayed({ timeout: 120_000 });
  await browser.waitUntil(
    async () => ((await frame.getAttribute("src")) ?? "").length > 200,
    { timeout: 60_000, timeoutMsg: "CDP screencast frame remained empty" },
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
    element: frame,
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

async function wheelRemote(
  metrics: FrameMetrics,
  point: WebFixturePoint,
): Promise<void> {
  const target = viewportPoint(metrics, point);
  await browser
    .action("wheel")
    .scroll({
      origin: metrics.element,
      x: Math.round(target.x - (metrics.left + metrics.renderedWidth / 2)),
      y: Math.round(target.y - (metrics.top + metrics.renderedHeight / 2)),
      deltaX: 0,
      deltaY: 520,
      duration: 150,
    })
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

async function persistedCommunityState(): Promise<PersistedCommunityState> {
  return browser.execute(() => {
    const parse = (key: string): unknown => {
      try {
        return JSON.parse(window.localStorage.getItem(key) ?? "null");
      } catch {
        return null;
      }
    };
    const communities = parse("buzz-communities");
    return {
      activeId: window.localStorage.getItem("buzz-active-community-id"),
      communities: Array.isArray(communities)
        ? communities.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const candidate = entry as { id?: unknown; relayUrl?: unknown };
            return typeof candidate.id === "string" &&
              typeof candidate.relayUrl === "string"
              ? [{ id: candidate.id, relayUrl: candidate.relayUrl }]
              : [];
          })
        : [],
    };
  }) as unknown as PersistedCommunityState;
}

async function addAndSwitchToCommunityB(): Promise<string> {
  await clickTestId("open-settings");
  await clickTestId("community-switcher");
  const add = await $(
    '//*[@role="menuitem" and contains(normalize-space(.), "Add a community")]',
  );
  await add.waitForDisplayed({ timeout: 30_000 });
  await add.click();
  await clickTestId("add-community-join");
  await fillTestId("invite-redeem-input", RELAY_B);
  await clickTestId("invite-redeem-submit");

  let communityB: PersistedCommunity | undefined;
  await browser.waitUntil(
    async () => {
      const state = await persistedCommunityState();
      communityB = state.communities.find(
        (community) => community.relayUrl === RELAY_B,
      );
      return communityB !== undefined && state.activeId === communityB.id;
    },
    {
      timeout: 120_000,
      timeoutMsg: `community B was not added and activated (${RELAY_B})`,
    },
  );
  if (!communityB) throw new Error("community B record disappeared");
  return communityB.id;
}

async function waitForCommunityReady(communityId: string): Promise<void> {
  const marker = await $(
    `[data-testid="community-lifecycle-marker"][data-community-id="${communityId}"][data-community-state="ready"]`,
  );
  await marker.waitForExist({
    timeout: 120_000,
    timeoutMsg: `community ${communityId} never reached ready`,
  });
  expect(await marker.getAttribute("data-community-relay")).toBe(RELAY_B);
}

function detachWdioSession(): void {
  const driver = (
    globalThis as typeof globalThis & {
      _wdioGlobals?: Map<string, unknown>;
    }
  )._wdioGlobals?.get("browser") as { sessionId?: string } | undefined;
  if (!driver) throw new Error("WDIO browser instance is unavailable");
  driver.sessionId = undefined;
}

async function proveFixtureInput(
  fixture: WebFixture,
  frame: ChainablePromiseElement,
): Promise<void> {
  await browser.waitUntil(() => fixture.receipts().targets !== null, {
    timeout: 60_000,
    timeoutMsg: "fixture never reported its CDP target coordinates",
  });
  const targets = fixture.receipts().targets;
  if (!targets) throw new Error("fixture target coordinates disappeared");
  const metrics = await frameMetrics(frame);

  await clickRemote(metrics, targets.input);
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

  await wheelRemote(metrics, targets.scroll);
  await browser.waitUntil(() => fixture.receipts().maxScrollY > 0, {
    timeout: 30_000,
    timeoutMsg: "remote scroll region never received forwarded wheel input",
  });

  const frameBeforeAction = await frame.getAttribute("src");
  await clickRemote(metrics, targets.action);
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
  it("proves real CDP frames, input, and owned browser cleanup", async () => {
    const fixture = await startWebFixture();
    try {
      await enableWebPreview();
      await ensureJoinedCommunity(RELAY_A);
      await openWorkspace();

      const first = await createOwnedWeb(fixture.url);
      const firstTree = await trackedTree(first.pid, "tab-close browser");
      await proveFixtureInput(fixture, first.frame);
      await browser.saveScreenshot("./e2e-real-shell/results/08-web.png");

      const firstTab = await $('[data-testid^="workspace-tab-"]');
      await firstTab.moveTo();
      const close = await firstTab.$('button[aria-label="Close Web"]');
      await close.waitForExist({ timeout: 30_000 });
      await close.click();
      await proveGone("tab-close browser tree", firstTree);

      const communitySession = await createOwnedWeb();
      const communityTree = await trackedTree(
        communitySession.pid,
        "community-reset browser",
      );
      const communityBId = await addAndSwitchToCommunityB();
      await proveGone("community-reset browser tree", communityTree);
      await waitForCommunityReady(communityBId);

      await openWorkspace();
      const quitSession = await createOwnedWeb();
      const quitBrowserTree = await trackedTree(
        quitSession.pid,
        "app-quit browser",
      );
      const appBundle = process.env.BUZZ_REAL_SHELL_APP ?? "";
      const app = await waitForProcessWhere(
        (row) => row.command.includes(appBundle),
        60_000,
        "packaged Colony app before Web quit proof",
      );
      const appTree = processTree(app.pid).map((row) => row.pid);

      await browser.tauri.execute(({ core }) => {
        setTimeout(() => {
          void core
            .invoke("plugin:window|close", { label: "main" })
            .catch(() => undefined);
        }, 0);
        return true;
      });
      detachWdioSession();
      await proveGone("app-quit browser tree", quitBrowserTree);
      await waitForPidsGone(
        [app.pid, ...appTree],
        120_000,
        "packaged Colony app tree",
      );
      // eslint-disable-next-line no-console
      console.log(`[08] app quit: appPid=${app.pid} kill-0=false ps=absent`);
      recordResult(
        "08-workspace-web",
        "pass",
        `fixture=${fixture.url} browserPid=${quitSession.pid}`,
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
