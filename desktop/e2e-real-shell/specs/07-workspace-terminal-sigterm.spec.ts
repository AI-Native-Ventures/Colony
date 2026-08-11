// Flow 07 — separate SIGTERM cleanup leg for packaged terminal sessions.
import { execFileSync } from "node:child_process";

import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import { clickTestId, waitForTestId } from "../helpers/app";
import {
  processTree,
  waitForPidsGone,
  waitForProcessWhere,
} from "../helpers/process";
import { ensureJoinedCommunity } from "../helpers/community";
import { recordResult } from "../helpers/results";

async function terminalBody() {
  const body = await $('[data-testid="workspace-terminal-body"]');
  await body.waitForDisplayed({ timeout: 120_000 });
  await browser.waitUntil(
    async () => (await body.getAttribute("data-status")) === "running",
    { timeout: 120_000, timeoutMsg: "SIGTERM terminal PTY never ran" },
  );
  return body;
}

async function sendTerminalCommand(command: string): Promise<void> {
  const helper = await $(".xterm-helper-textarea");
  await helper.waitForExist({ timeout: 30_000 });
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
      timeoutMsg: `SIGTERM terminal output never contained ${needle}`,
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
  driver.sessionId = undefined;
}

describe("07 packaged workspace terminal SIGTERM", () => {
  it("reaps every live terminal process when the app receives SIGTERM", async () => {
    try {
      await ensureJoinedCommunity(
        process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3040",
      );
      await openWorkspace();
      // A prior normal-exit leg deliberately leaves its tab metadata persisted
      // so the inactive-body remount can be proven. Start this independent
      // signal leg from a fresh new-tab page; only the two sessions created
      // below are live native sessions that must be reaped.
      await clickTestId("workspace-new-tab");
      await waitForTestId("workspace-create-terminal", 30_000);
      await clickTestId("workspace-create-terminal");
      const first = await terminalBody();
      const firstPid = Number(await first.getAttribute("data-pid"));
      await sendTerminalCommand(
        "sleep 30 & printf 'terminal-sigterm-output\\n'",
      );
      await waitForTerminalOutput("terminal-sigterm-output");
      await clickTestId("workspace-new-tab");
      await clickTestId("workspace-create-terminal");
      const second = await terminalBody();
      const secondPid = Number(await second.getAttribute("data-pid"));
      await sendTerminalCommand(
        "sleep 30 & printf 'terminal-sigterm-second\\n'",
      );
      await waitForTerminalOutput("terminal-sigterm-second");
      expect(firstPid).toBeGreaterThan(0);
      expect(secondPid).toBeGreaterThan(0);
      await browser.waitUntil(
        async () =>
          processTree(firstPid).length > 0 && processTree(secondPid).length > 0,
        {
          timeout: 10_000,
          timeoutMsg: "SIGTERM terminal leaders did not expose child processes",
        },
      );
      const firstTree = processTree(firstPid).map((row) => row.pid);
      const secondTree = processTree(secondPid).map((row) => row.pid);
      const tracked = [
        ...new Set([firstPid, secondPid, ...firstTree, ...secondTree]),
      ];
      // eslint-disable-next-line no-console
      console.log(
        `[07] SIGTERM process trees: ${JSON.stringify({ first: [firstPid, firstTree], second: [secondPid, secondTree] })}`,
      );

      const appBundle = process.env.BUZZ_REAL_SHELL_APP ?? "";
      const app = await waitForProcessWhere(
        (row) => row.command.includes(appBundle),
        60_000,
        "packaged Colony app before SIGTERM",
      );
      execFileSync("/bin/kill", ["-TERM", String(app.pid)]);
      // SIGTERM intentionally takes down the embedded WebDriver server with the
      // app. Avoid a teardown DELETE /session retry after the process is already
      // proven gone by kill -0 below.
      detachWdioSession();
      await waitForPidsGone(
        [app.pid, ...tracked],
        120_000,
        "SIGTERM app and every terminal process tree",
      );
      // eslint-disable-next-line no-console
      console.log(
        `[07] SIGTERM PID evidence: appPid=${app.pid} kill-0=false; all terminal leaders/descendants kill-0=false`,
      );
      recordResult(
        "07-workspace-terminal-sigterm",
        "pass",
        `appPid=${app.pid}`,
      );
    } catch (cause: unknown) {
      recordResult(
        "07-workspace-terminal-sigterm",
        "fail",
        cause instanceof Error ? cause.message : String(cause),
      );
      throw cause;
    }
  });
});
