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

async function emit(page: import("@playwright/test").Page, content: string) {
  const message = await page.evaluate(
    ({ body, pubkey }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: body,
        pubkey,
        createdAt: Math.floor(Date.now() / 1000) + 60,
      }),
    { body: content, pubkey: TEST_IDENTITIES.alice.pubkey },
  );
  if (!message) throw new Error("Mock message emitter is unavailable");
  return message;
}

test("clicking a file path in a message opens the file in the workspace", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await waitForSubscription(page);

  const message = await emit(page, "Wrote the plan up in `PLANS/FOO.md`.");
  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();

  await row.getByTestId("file-path-chip").click();

  await expect(page.getByTestId("channel-workspace")).toBeVisible();
  await expect(page.getByRole("tab", { name: "FOO.md" })).toBeVisible();
  await expect(page.getByTestId("workspace-file-body")).toContainText(
    "Step one: prove the path opens.",
  );
});

test("a code span that is not a file path stays plain text", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await waitForSubscription(page);

  const message = await emit(
    page,
    "The response is `text/markdown`, served by `and/or` nothing else.",
  );
  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByText("text/markdown")).toBeVisible();
  await expect(row.getByTestId("file-path-chip")).toHaveCount(0);
});
