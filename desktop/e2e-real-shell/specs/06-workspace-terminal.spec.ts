// Flow 06 — drive the packaged terminal tab through a real PTY.
//
// This flow intentionally uses no mock bridge. The prompts, writes, output,
// process trees, community boundary, and normal window exit all cross the
// packaged Tauri/native boundary.
import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import { clickTestId, fillTestId, waitForTestId } from "../helpers/app";
import {
  processTree,
  waitForPidsGone,
  waitForProcessWhere,
} from "../helpers/process";
import { ensureJoinedCommunity } from "../helpers/community";
import { recordResult } from "../helpers/results";

const RELAY_A = process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3040";
const RELAY_B = RELAY_A.replace("localhost", "127.0.0.1");

async function terminalBody() {
  const body = await $('[data-testid="workspace-terminal-body"]');
  await body.waitForDisplayed({ timeout: 120_000 });
  try {
    await browser.waitUntil(
      async () => (await body.getAttribute("data-status")) === "running",
      { timeout: 120_000, timeoutMsg: "terminal PTY never reached running" },
    );
  } catch (cause) {
    const error = await $('[data-testid="workspace-terminal-error"]')
      .getText()
      .catch(() => "");
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}${
        error ? `; native error: ${error}` : ""
      }`,
    );
  }
  return body;
}

async function terminalPid(body: {
  getAttribute(name: string): Promise<string | null>;
}): Promise<number> {
  const value = await body.getAttribute("data-pid");
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`terminal did not expose a live pid: ${value}`);
  }
  return pid;
}

async function sendTerminalCommand(command: string): Promise<void> {
  const helper = await $(".xterm-helper-textarea");
  await helper.waitForExist({ timeout: 30_000 });
  // xterm intentionally renders its helper textarea transparent. addValue
  // sends ordinary text key events to that real renderer without requiring
  // the textarea to satisfy WDIO's visibility heuristic.
  await helper.addValue(command);
  await browser.keys([Key.Enter]);
}

async function waitForTerminalOutput(needle: string): Promise<void> {
  const body = await $('[data-testid="workspace-terminal-body"]');
  await browser.waitUntil(
    async () =>
      ((await body.getAttribute("data-output")) ?? "").includes(needle),
    {
      timeout: 60_000,
      timeoutMsg: `terminal output never contained ${needle}`,
    },
  );
}

async function waitForVisibleTerminalText(needle: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected) =>
          document
            .querySelector(
              '[data-testid="workspace-terminal-body"] .xterm-rows',
            )
            ?.textContent?.includes(expected) ?? false,
        needle,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `xterm rows never visibly rendered ${needle}`,
    },
  );
}

async function openWorkspace(): Promise<void> {
  await clickTestId("channel-general");
  const toggle = await $('[data-testid="channel-workspace-toggle"]');
  await toggle.waitForDisplayed({ timeout: 60_000 });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="channel-workspace-toggle"]').getAttribute(
        "aria-pressed",
      )) === "true",
    {
      timeout: 30_000,
      timeoutMsg: "channel workspace toggle never entered workspace mode",
    },
  );
  await waitForTestId("channel-workspace", 30_000);
}

async function createTerminalTab() {
  await clickTestId("workspace-create-terminal");
  const body = await terminalBody();
  return { body, pid: await terminalPid(body) };
}

async function waitForCommunityReady(communityId: string): Promise<void> {
  const marker = await $(
    `[data-testid="community-lifecycle-marker"][data-community-id="${communityId}"][data-community-state="ready"]`,
  );
  await marker.waitForExist({
    timeout: 120_000,
    timeoutMsg: `community ${communityId} never reached the applied/ready marker`,
  });
  expect(await marker.getAttribute("data-community-relay")).toBe(RELAY_B);
}

type PersistedCommunity = {
  id: string;
  relayUrl: string;
};

type PersistedCommunityState = {
  activeId: string | null;
  communities: PersistedCommunity[];
};

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
            const candidate = entry as {
              id?: unknown;
              relayUrl?: unknown;
            };
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
  // The community actions live in the profile popover in the packaged shell.
  // Open that real UI surface before selecting the switcher trigger.
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

  // The harness uses one seeded relay under two host-bound community URLs.
  // The identity already has a profile there, so a real B connection may
  // skip profile onboarding. Observe the persisted community record and the
  // active ID instead of assuming a fresh-profile screen.
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
  if (!communityB) {
    throw new Error(`community B record disappeared (${RELAY_B})`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[06] community B activated: id=${communityB.id} relay=${RELAY_B}`,
  );
  return communityB.id;
}

async function processEvidence(
  label: string,
  pids: number[],
): Promise<number[]> {
  await browser.waitUntil(
    async () => pids.every((pid) => processTree(pid).length > 0),
    {
      timeout: 10_000,
      timeoutMsg: `${label} did not expose a descendant process for every terminal leader`,
    },
  );
  const trees = pids.map((pid) => [
    pid,
    processTree(pid).map((row) => row.pid),
  ]);
  const flattened = trees.flatMap(([, descendants]) => descendants as number[]);
  // eslint-disable-next-line no-console
  console.log(`[06] ${label} process trees: ${JSON.stringify(trees)}`);
  return [...new Set([...pids, ...flattened])];
}

function detachWdioSession(): void {
  const driver = (
    globalThis as typeof globalThis & {
      _wdioGlobals?: Map<string, unknown>;
    }
  )._wdioGlobals?.get("browser") as
    | {
        sessionId?: string;
      }
    | undefined;
  if (!driver) {
    throw new Error("WDIO browser instance is unavailable for detach");
  }
  // The packaged app owns the embedded WebDriver server. Once the real
  // process-exit proof begins, WDIO's automatic DELETE /session would race
  // the server's intentional shutdown and turn a passing PID proof into a
  // transport failure.
  driver.sessionId = undefined;
}

describe("06 packaged workspace terminal", () => {
  it("proves PTY I/O, inactive preservation, A→B cleanup, and normal exit", async () => {
    try {
      await ensureJoinedCommunity(RELAY_A);

      await openWorkspace();
      const first = await createTerminalTab();
      await browser.waitUntil(
        async () =>
          ((await first.body.getAttribute("data-output")) ?? "").length > 0,
        {
          timeout: 60_000,
          timeoutMsg: "first terminal never produced a prompt",
        },
      );
      // Keep a real child alive so the process-tree assertion observes more
      // than a leader PID and cleanup must reap both the shell and its child.
      await sendTerminalCommand("sleep 30 & printf 'terminal-%s-output\\n' a");
      await waitForTerminalOutput("terminal-a-output");
      await waitForVisibleTerminalText("terminal-a-output");

      // Detour through a non-terminal kind while the first PTY keeps running.
      // Returning to the Terminal must remount xterm without restarting or
      // blanking the buffered native output.
      await clickTestId("workspace-new-tab");
      await clickTestId("workspace-create-scratchpad");
      const scratchpad = await $('[data-testid="workspace-scratchpad-body"]');
      await scratchpad.waitForDisplayed({ timeout: 30_000 });
      await scratchpad.setValue("Terminal process remains live across tabs");
      expect(await scratchpad.getValue()).toContain("remains live");
      const tabsAfterScratchpad = await $$('[role="tab"]');
      await tabsAfterScratchpad[0].click();
      const remountedFirst = await terminalBody();
      expect(await terminalPid(remountedFirst)).toBe(first.pid);
      await waitForVisibleTerminalText("terminal-a-output");
      // eslint-disable-next-line no-console
      console.log(
        `[06] Scratchpad detour preserved terminal leader=${first.pid} and visible output`,
      );

      await clickTestId("workspace-new-tab");
      const second = await createTerminalTab();
      await sendTerminalCommand("sleep 30 & printf 'terminal-%s-output\\n' b");
      await waitForTerminalOutput("terminal-b-output");
      const pidsA = await processEvidence("community A", [
        first.pid,
        second.pid,
      ]);

      // The first session is inactive while the second tab is selected. Return
      // to it and prove the output survived body unmount/remount.
      const tabs = await $$('[role="tab"]');
      expect(tabs.length).toBeGreaterThanOrEqual(3);
      await tabs[0].click();
      await waitForTerminalOutput("terminal-a-output");
      await waitForVisibleTerminalText("terminal-a-output");
      await browser.saveScreenshot("./e2e-real-shell/results/06-terminal.png");

      // Exercise the destructive tab-close boundary against the first real
      // session before switching communities. The PTY body is active here;
      // closing it selects the adjacent Scratchpad, so explicitly return to
      // the remaining Terminal before checking its stable native PID.
      const firstTabPids = [
        first.pid,
        ...processTree(first.pid).map((row) => row.pid),
      ];
      const firstTabEntry = await $('[data-testid^="workspace-tab-"]');
      await firstTabEntry.moveTo();
      const closeFirstTab = await firstTabEntry.$(
        'button[aria-label="Close Terminal"]',
      );
      await closeFirstTab.waitForExist({ timeout: 30_000 });
      await closeFirstTab.click();
      const remainingTerminalTab = await $(
        '//*[@role="tab" and contains(normalize-space(.), "Terminal")]',
      );
      await remainingTerminalTab.waitForDisplayed({ timeout: 30_000 });
      await remainingTerminalTab.click();
      const remainingTerminal = await terminalBody();
      expect(await terminalPid(remainingTerminal)).toBe(second.pid);
      await waitForPidsGone(firstTabPids, 60_000, "closed A terminal tab tree");
      // eslint-disable-next-line no-console
      console.log(
        `[06] close-tab PID evidence: leader=${first.pid} descendants=${firstTabPids
          .slice(1)
          .join(",")} kill-0=false`,
      );

      const appBundle = process.env.BUZZ_REAL_SHELL_APP ?? "";
      const appBeforeSwitch = await waitForProcessWhere(
        (row) => row.command.includes(appBundle),
        120_000,
        "packaged Colony app before community switch",
      );
      // Adding B exercises the real community onboarding path. The app's
      // resetCommunityState() must close every A session before B is applied.
      const communityBId = await addAndSwitchToCommunityB();
      // The active ID changes before useCommunityInit applies B. This is the
      // observable handoff point; resetCommunityState() must finish draining
      // every A session before the later B-ready assertion can pass.
      await waitForPidsGone(
        pidsA,
        60_000,
        "community A terminal process trees",
      );
      await waitForCommunityReady(communityBId);
      // eslint-disable-next-line no-console
      console.log(
        `[06] community A cleanup observed before B ready: appPid=${appBeforeSwitch.pid} pids=${pidsA.join(",")}`,
      );

      // B has independent runtime sessions. Capture both trees before the
      // normal window close, including the inactive tab.
      await openWorkspace();
      const bFirst = await createTerminalTab();
      await sendTerminalCommand("sleep 30 & printf 'terminal-%s-live\\n' b");
      await waitForTerminalOutput("terminal-b-live");
      await clickTestId("workspace-new-tab");
      const bSecond = await createTerminalTab();
      await sendTerminalCommand("sleep 30 & printf 'terminal-%s-second\\n' b");
      await waitForTerminalOutput("terminal-b-second");
      const pidsB = await processEvidence("community B", [
        bFirst.pid,
        bSecond.pid,
      ]);
      expect(pidsB).toContain(bFirst.pid);
      expect(pidsB).toContain(bSecond.pid);

      const rootFontBefore = await browser.execute(
        () => getComputedStyle(document.documentElement).fontSize,
      );
      const terminalFontBefore = Number(
        await (await $('[data-testid="workspace-terminal-body"]')).getAttribute(
          "data-terminal-font-size",
        ),
      );
      await browser.keys([Key.Command, "+"]);
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => getComputedStyle(document.documentElement).fontSize,
          )) !== rootFontBefore,
        {
          timeout: 10_000,
          timeoutMsg: "packaged Cmd+ zoom did not change root font size",
        },
      );
      const zoomedRootFont = await browser.execute(
        () => getComputedStyle(document.documentElement).fontSize,
      );
      const zoomedTerminalFont = await (
        await $('[data-testid="workspace-terminal-body"]')
      ).getAttribute("data-terminal-font-size");
      expect(zoomedRootFont).not.toBe(rootFontBefore);
      expect(Number(zoomedTerminalFont)).toBeGreaterThan(terminalFontBefore);
      console.log(
        `[06] packaged zoom evidence: root=${rootFontBefore}->${zoomedRootFont} xterm=${terminalFontBefore}->${zoomedTerminalFont}`,
      );
      await browser.keys([Key.Command, "-"]);

      const app = await waitForProcessWhere(
        (row) => row.command.includes(appBundle),
        60_000,
        "packaged Colony app before normal exit",
      );
      const appTree = processTree(app.pid).map((row) => row.pid);
      // eslint-disable-next-line no-console
      console.log(
        `[06] normal-exit app process tree: ${JSON.stringify([app.pid, appTree])}`,
      );

      // This is the real window-close action. It must reach Tauri's
      // RunEvent::ExitRequested/Exit handlers, not a test-only close flag. Use
      // the same Tauri window-plugin operation as NativeBridge.closeWindow(),
      // issued through the native WDIO boundary. WebDriver's closeWindow()
      // helper performs a follow-up window-handle query after the app exits;
      // that query races the deliberate process shutdown and marks an otherwise
      // complete proof as a driver failure.
      await browser.tauri.execute(({ core }) => {
        // Let the WebDriver execute request complete before the app processes
        // the close event; otherwise the embedded server can disappear while
        // serializing the command response and report a false fetch failure.
        setTimeout(() => {
          void core
            .invoke("plugin:window|close", { label: "main" })
            .catch(() => undefined);
        }, 0);
        return true;
      });
      // The embedded WebDriver server lives inside the app, so a successful
      // normal exit necessarily takes the server down before WDIO's worker
      // teardown can issue DELETE /session. Mark that already-completed driver
      // session detached; the process/PID assertions below are the authoritative
      // shutdown proof and no WebDriver call is made after this point.
      detachWdioSession();
      await waitForPidsGone(
        [app.pid, ...appTree, ...pidsB],
        120_000,
        "normal app exit and community B terminal process trees",
      );
      // eslint-disable-next-line no-console
      console.log(
        `[06] normal exit PID evidence: appPid=${app.pid} kill-0=false; all B leaders/descendants kill-0=false`,
      );
      recordResult("06-workspace-terminal", "pass", `appPid=${app.pid}`);
    } catch (cause: unknown) {
      recordResult(
        "06-workspace-terminal",
        "fail",
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  });
});
