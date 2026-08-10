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
  test("keeps the default-off preview out of creation and native start", async ({
    page,
  }) => {
    await installMockBridge(page, undefined, { seedPreviewFeatures: false });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();

    await expect(page.getByTestId("workspace-new-tab-page")).toBeVisible();
    await expect(page.getByTestId("workspace-create-web")).toHaveCount(0);
    await expect(page.getByTestId("workspace-web-body")).toHaveCount(0);
    expect((await commands(page)).map((entry) => entry.command)).not.toContain(
      "workspace_web_start",
    );
  });

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
    await expect(page.getByTestId("workspace-web-toolbar")).toBeVisible();
    await expect(
      page.getByTestId("workspace-web-advanced"),
    ).not.toHaveAttribute("open");
    await expect(
      page.getByText("DevTools endpoint (optional)"),
    ).not.toBeVisible();

    await page.getByTestId("workspace-web-url").fill("about:blank");
    await page.getByTestId("workspace-web-url").press("Enter");
    await expect(web).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("workspace-web-frame")).toBeVisible();

    await page.getByTestId("workspace-web-url").fill("http://127.0.0.1:8778");
    await page.getByTestId("workspace-web-navigate").click();
    await web.focus();
    await page.keyboard.press("a");

    const frame = page.getByTestId("workspace-web-frame");
    await frame.dispatchEvent("mousemove", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 0,
    });
    await frame.dispatchEvent("mousedown", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 1,
    });
    await frame.dispatchEvent("mouseup", {
      button: 0,
      clientX: 1,
      clientY: 1,
      detail: 1,
    });
    await frame.dispatchEvent("wheel", {
      clientX: 1,
      clientY: 1,
      deltaY: 120,
    });

    await expect
      .poll(async () => (await commands(page)).map((entry) => entry.command))
      .toEqual(
        expect.arrayContaining([
          "workspace_web_start",
          "workspace_web_navigate",
          "workspace_web_key",
          "workspace_web_mouse",
          "workspace_web_resize",
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
    await expect(page.getByTestId("channel-workspace-pane")).toHaveCount(0);
    await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
    await expect
      .poll(async () => (await commands(page)).map((entry) => entry.command))
      .toContain("workspace_web_close");
  });
});
