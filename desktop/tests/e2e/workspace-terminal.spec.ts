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

type TerminalDims = { cols: number; rows: number } | null;

async function terminalDims(
  page: Parameters<typeof installMockBridge>[0],
): Promise<TerminalDims> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_TERMINAL_DIMS__?: () => TerminalDims;
        }
      ).__BUZZ_E2E_TERMINAL_DIMS__?.() ?? null,
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

/**
 * Output no longer round-trips through a DOM attribute: it is written
 * straight into xterm, so the rendered rows are the only evidence.
 */
async function terminalText(terminal: Locator): Promise<string> {
  try {
    const hookText = await terminal
      .page()
      .evaluate(
        () =>
          (
            window as Window & { __BUZZ_E2E_TERMINAL_TEXT__?: () => string }
          ).__BUZZ_E2E_TERMINAL_TEXT__?.() ?? "",
      );
    if (hookText) return hookText.replace(/\u00a0/g, " ");
  } catch {
    // Hook absent or throws; fall back to DOM rows.
  }
  const text = await terminal.locator(".xterm-rows").innerText();
  return text.replace(/\u00a0/g, " ");
}

async function expectMockInputOutput(terminal: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const output = await terminalText(terminal);
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
    await expect.poll(async () => await terminalText(terminal)).toContain("$");

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

    // The pane is far wider than the 80-column default the PTY starts with:
    // xterm must have been fitted to it, and the PTY told the fitted size.
    await page.waitForFunction(
      () =>
        typeof (window as Window & { __BUZZ_E2E_TERMINAL_DIMS__?: unknown })
          .__BUZZ_E2E_TERMINAL_DIMS__ === "function",
    );
    await expect
      .poll(async () => (await terminalDims(page))?.cols ?? 0)
      .toBeGreaterThan(80);
    const fittedDims = await terminalDims(page);
    expect(fittedDims).not.toBeNull();
    await expect
      .poll(async () => {
        const resizes = (await terminalCommands(page)).filter(
          (entry) => entry.command === "workspace_terminal_resize",
        );
        const last = resizes.at(-1)?.payload as
          | { cols?: number; rows?: number }
          | undefined;
        return last ? { cols: last.cols, rows: last.rows } : null;
      })
      .toEqual({ cols: fittedDims?.cols, rows: fittedDims?.rows });

    await page.getByTestId("workspace-new-tab").click();
    await page.getByTestId("workspace-create-scratchpad").click();
    await page.getByRole("tab", { name: "Terminal" }).click();
    const remounted = page.getByTestId("workspace-terminal-body");
    await expect(remounted).toBeVisible();
    // Visible is not attached: the host element is in the DOM a frame before
    // the xterm instance is built on it, and on a cold load the xterm chunk
    // lands tens of milliseconds later still. Both the mount marker and the
    // instance's own dimensions hook have to be there before its buffer can
    // be read, or the text poll spends its whole budget against an element
    // that has no terminal (this is the 1-in-2 cold-run failure here).
    await expect(remounted).toHaveAttribute("data-terminal-font-size", /\d/);
    await expect
      .poll(async () => (await terminalDims(page))?.cols ?? 0)
      .toBeGreaterThan(0);
    await expect
      .poll(async () => terminalText(remounted))
      .toContain("mock-output:h");
    // Cmd +/- scales the virtual typography rem and leaves the real root at
    // 16px (#5644), so the terminal follows `--buzz-type-rem` and the root is
    // asserted to hold still rather than to move.
    const readTypeRem = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--buzz-type-rem")
          .trim(),
      );
    const rootBefore = await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    );
    const typeRemBefore = await readTypeRem();
    const colsBefore = (await terminalDims(page))?.cols ?? 0;
    await dispatchPrimaryShortcut(page, "+", "Equal", true);
    await expect.poll(readTypeRem).not.toBe(typeRemBefore);
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).fontSize,
      ),
    ).toBe(rootBefore);
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
    // Bigger type in the same pane means fewer columns, and the PTY is told:
    // a font change that does not re-fit leaves the shell wrapping at the old
    // width.
    await expect
      .poll(async () => (await terminalDims(page))?.cols ?? 0)
      .toBeLessThan(colsBefore);
    const zoomedDims = await terminalDims(page);
    await expect
      .poll(async () => {
        const resizes = (await terminalCommands(page)).filter(
          (entry) => entry.command === "workspace_terminal_resize",
        );
        const last = resizes.at(-1)?.payload as
          | { cols?: number; rows?: number }
          | undefined;
        return last ? { cols: last.cols, rows: last.rows } : null;
      })
      .toEqual({ cols: zoomedDims?.cols, rows: zoomedDims?.rows });
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
