import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

type LoggedCommand = { command: string; payload: unknown };

async function commands(page: Parameters<typeof installMockBridge>[0]) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_WEB_COMMANDS__?: () => LoggedCommand[];
        }
      ).__BUZZ_E2E_WEB_COMMANDS__?.() ?? [],
  );
}

test.describe("web workspace tab", () => {
  test("wires the web registry, mock frame, scaled input, and cleanup", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-web").click();

    const web = page.getByTestId("workspace-web-body");
    await expect(web).toBeVisible();
    await expect(web).toHaveAttribute("data-status", "idle");

    await page.getByTestId("workspace-web-connect").click();
    await expect(web).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("workspace-web-frame")).toBeVisible();

    await page.getByTestId("workspace-web-url").fill("http://127.0.0.1:8778");
    await page.getByTestId("workspace-web-navigate").click();
    await web.focus();
    await page.keyboard.press("a");

    const frame = page.getByTestId("workspace-web-frame");
    await frame.dispatchEvent("pointermove", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 0,
    });
    await frame.dispatchEvent("pointerdown", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 1,
    });
    await frame.dispatchEvent("pointerup", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 1,
    });
    await frame.hover();
    await page.mouse.wheel(0, 120);

    await expect
      .poll(async () => (await commands(page)).map((entry) => entry.command))
      .toEqual(
        expect.arrayContaining([
          "workspace_web_start",
          "workspace_web_navigate",
          "workspace_web_key",
          "workspace_web_mouse",
        ]),
      );
    await expect
      .poll(() => commands(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "workspace_web_key",
            payload: expect.objectContaining({
              input: expect.objectContaining({ text: "a" }),
            }),
          }),
        ]),
      );

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace-web/01-web-mock.png",
    });

    await page.getByRole("button", { name: "Close Web" }).click();
    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
    await expect
      .poll(async () => (await commands(page)).map((entry) => entry.command))
      .toContain("workspace_web_close");
  });
});
