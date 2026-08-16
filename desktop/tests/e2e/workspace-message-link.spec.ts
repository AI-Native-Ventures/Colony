import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

async function waitForSubscription(page: import("@playwright/test").Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "general",
          }) ?? false,
      ),
    )
    .toBe(true);
}

test("opens the first safe message link in the channel workspace browser", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await waitForSubscription(page);

  const message = await page.evaluate(
    ({ pubkey }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content:
          "Read [the guide](https://docs.example.com/guide), then https://later.example.test.",
        pubkey,
        createdAt: Math.floor(Date.now() / 1000) + 60,
      }),
    { pubkey: TEST_IDENTITIES.alice.pubkey },
  );
  if (!message) throw new Error("Mock message emitter is unavailable");

  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  await page.getByTestId(`more-actions-${message.id}`).click();
  await page.getByTestId(`open-workspace-${message.id}`).click();

  await expect(page.getByTestId("channel-workspace")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "docs.example.com" }),
  ).toBeVisible();
  await expect(page.getByTestId("workspace-web-url")).toHaveValue(
    "https://docs.example.com/guide",
  );
});

test("clicking a message link opens that link in the workspace browser", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await waitForSubscription(page);

  const message = await page.evaluate(
    ({ pubkey }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content:
          "First https://docs.example.com/guide, then [the second](https://second.example.com/page).",
        pubkey,
        createdAt: Math.floor(Date.now() / 1000) + 60,
      }),
    { pubkey: TEST_IDENTITIES.alice.pubkey },
  );
  if (!message) throw new Error("Mock message emitter is unavailable");

  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();

  // The second link, so a pass cannot come from the action bar's
  // first-URL-in-the-body behaviour.
  await row.getByRole("link", { name: "the second" }).click();

  await expect(page.getByTestId("channel-workspace")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "second.example.com" }),
  ).toBeVisible();
  await expect(page.getByTestId("workspace-web-url")).toHaveValue(
    "https://second.example.com/page",
  );
});
