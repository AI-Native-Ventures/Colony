import { expect, test, type Locator } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { installTerminalMockBridge } from "../helpers/terminalBridge";

type TerminalCommand = { command: string; payload: unknown };

async function terminalCommands(page: Parameters<typeof installMockBridge>[0]) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_TERMINAL_COMMANDS__?: () => TerminalCommand[];
        }
      ).__BUZZ_E2E_TERMINAL_COMMANDS__?.() ?? [],
  );
}

async function dispatchPrimaryShortcut(
  page: Parameters<typeof installMockBridge>[0],
  key: string,
  code: string,
  shiftKey = false,
) {
  await page.evaluate(
    ({ code, key, shiftKey }) => {
      const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform);
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          code,
          ctrlKey: !isMac,
          key,
          metaKey: isMac,
          shiftKey,
        }),
      );
    },
    { code, key, shiftKey },
  );
}

async function expectMockInputOutput(terminal: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const output = (await terminal.getAttribute("data-output")) ?? "";
      return ["h", "e", "l", "l", "o"].every((character) =>
        output.includes(`mock-output:${character}`),
      );
    })
    .toBe(true);
}

test.describe("terminal workspace tab", () => {
  test("renders a real xterm body, preserves it across remount, and wires PTY events", async ({
    page,
  }) => {
    await installTerminalMockBridge(page);
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-terminal").click();

    const terminal = page.getByTestId("workspace-terminal-body");
    await expect(terminal).toBeVisible();
    await expect
      .poll(async () => (await terminal.getAttribute("data-status")) ?? "")
      .toBe("running");
    await expect
      .poll(async () => (await terminal.getAttribute("data-output")) ?? "")
      .toContain("$ ");

    await terminal.click();
    await page.keyboard.type("hello");
    await expectMockInputOutput(terminal);

    await expect
      .poll(async () =>
        Number(await terminal.getAttribute("data-terminal-font-size")),
      )
      .toBeGreaterThan(0);
    const terminalFontBefore = Number(
      await terminal.getAttribute("data-terminal-font-size"),
    );

    const commands = await terminalCommands(page);
    expect(commands.map((entry) => entry.command)).toEqual(
      expect.arrayContaining([
        "workspace_terminal_start",
        "workspace_terminal_resize",
        "workspace_terminal_write",
      ]),
    );

    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByRole("tab", { name: "Terminal" }).click();
    await expect(page.getByTestId("workspace-terminal-body")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await page
            .getByTestId("workspace-terminal-body")
            .getAttribute("data-output")) ?? "",
      )
      .toContain("mock-output:h");
    await expect(
      page.getByTestId("workspace-terminal-body").locator(".xterm-rows"),
    ).toContainText("mock-output:h");

    const rootBefore = await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    );
    await dispatchPrimaryShortcut(page, "+", "Equal", true);
    await expect
      .poll(async () =>
        page.evaluate(
          () => getComputedStyle(document.documentElement).fontSize,
        ),
      )
      .not.toBe(rootBefore);
    await expect
      .poll(async () =>
        page
          .getByTestId("workspace-terminal-body")
          .getAttribute("data-terminal-font-size"),
      )
      .not.toBe(String(terminalFontBefore));
    const terminalFontAfter = Number(
      await page
        .getByTestId("workspace-terminal-body")
        .getAttribute("data-terminal-font-size"),
    );
    expect(terminalFontAfter).toBeGreaterThan(terminalFontBefore);
    await dispatchPrimaryShortcut(page, "-", "Minus");

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace-terminal/01-terminal-mock.png",
    });
  });

  test("closing the terminal invokes native process cleanup", async ({
    page,
  }) => {
    await installTerminalMockBridge(page);
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-terminal").click();
    await expect(page.getByTestId("workspace-terminal-body")).toBeVisible();
    await page.getByRole("button", { name: "Close Terminal" }).click();
    await expect(page.getByTestId("channel-workspace-pane")).toHaveCount(0);
    await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
    await expect
      .poll(async () =>
        (await terminalCommands(page)).map((entry) => entry.command),
      )
      .toContain("workspace_terminal_close");
  });
});
