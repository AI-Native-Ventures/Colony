import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

async function openCommandPalette(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByTestId("open-search")).toBeVisible();

  await page.evaluate(() => {
    const isMac = /mac|iphone|ipad|ipod/i.test(navigator.platform);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        code: "KeyK",
        ctrlKey: !isMac,
        key: "k",
        metaKey: isMac,
      }),
    );
  });

  await expect(page.getByTestId("search-results")).toBeVisible();
  await expect(page.getByTestId("search-dialog-input")).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test("filters navigation commands and opens the selected destination", async ({
  page,
}) => {
  await openCommandPalette(page);

  const input = page.getByTestId("search-dialog-input");
  await expect(
    page.getByTestId("search-result-action-open-settings"),
  ).toBeVisible();
  await input.fill("settings");
  const settingsCommand = page.getByTestId(
    "search-result-action-open-settings",
  );
  await expect(settingsCommand).toBeVisible();
  await expect(settingsCommand).toContainText("Open settings");

  await input.press("Enter");

  await expect(page).toHaveURL(/#\/settings(?:\?section=profile)?$/);
  await expect(page.getByTestId("settings-view")).toBeVisible();
});

test("keeps channel search results available alongside commands", async ({
  page,
}) => {
  await openCommandPalette(page);

  const input = page.getByTestId("search-dialog-input");
  await input.fill("general");
  const channelResult = page.getByTestId(
    "search-result-channel-9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
  );
  await expect(channelResult).toBeVisible();
  await channelResult.click();

  await expect(page).toHaveURL(
    /#\/channels\/9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50$/,
  );
  await expect(page.getByTestId("chat-title")).toHaveText("general");
});
