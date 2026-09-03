import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const SHORTCODE = "buzz";
const STATUS_TEXT = "testing custom status";
const MOCK_IDENTITY_PUBKEY = "deadbeef".repeat(8);

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ currentChannelName, kind: k }) => {
          return (
            (
              window as Window & {
                __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                  channelName: string;
                  kind?: number;
                }) => boolean;
              }
            ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: currentChannelName,
              kind: k,
            }) ?? false
          );
        },
        { currentChannelName: channelName, kind },
      );
    })
    .toBe(true);
}

async function openProfilePopover(page: import("@playwright/test").Page) {
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("profile-popover")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGMwuBPxnxLMMGrAqAGjBgwXAwBwOGMf1PPhVwAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route("https://example.com/e2e/**", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
});

test("profile popover renders a custom emoji status as an image", async ({
  page,
}) => {
  await page.goto("/");
  await openProfilePopover(page);

  await page.getByTestId("profile-popover-set-status").click();
  await expect(page.getByTestId("set-status-dialog")).toBeVisible();
  await page.getByLabel("Choose status emoji").click();

  const picker = page.locator("em-emoji-picker");
  await picker.locator("input[type='search']").fill(SHORTCODE);
  await picker
    .getByRole("button", { name: `:${SHORTCODE}:` })
    .first()
    .click();
  await page.getByTestId("set-status-input").fill(STATUS_TEXT);
  await page.getByTestId("set-status-save").click();

  await openProfilePopover(page);

  const statusButton = page.getByTestId("profile-popover-set-status");
  await expect(statusButton).toContainText(STATUS_TEXT);
  await expect(statusButton.locator(`img[alt=":${SHORTCODE}:"]`)).toBeVisible();
  await expect(statusButton).not.toContainText(`:${SHORTCODE}:`);
});

// Upstream's case also drives the huddle indicator; that half rides on the
// huddle presence runtime, which is not ported here, so this keeps the status
// indicator only.
test("shows the status indicator beside chat names with a tooltip", async ({
  page,
}) => {
  await page.goto("/");
  await openProfilePopover(page);
  await page.getByTestId("profile-popover-set-status").click();
  await page.getByTestId("set-status-input").fill(STATUS_TEXT);
  await page.getByTestId("set-status-save").click();

  await openProfilePopover(page);
  const statusButton = page.getByTestId("profile-popover-set-status");
  await expect(statusButton.getByText("💬", { exact: true })).toBeVisible();
  await expect(statusButton.locator("svg")).toHaveCount(0);
  await expect(statusButton.locator("[title]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("profile-popover")).not.toBeVisible();

  await page.getByTestId("channel-alice-tyler").click();
  await waitForMockLiveSubscription(page, "alice-tyler");
  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "alice-tyler",
      content: "Status indicator fixture",
      kind: 40002,
      pubkey,
    });
  }, MOCK_IDENTITY_PUBKEY);
  const row = page.getByTestId("message-row").filter({
    hasText: "Status indicator fixture",
  });
  const statusIndicator = row.getByTestId("user-status-indicator");
  await expect(statusIndicator).toBeVisible();
  await expect(statusIndicator).toHaveAttribute(
    "aria-label",
    `💬 ${STATUS_TEXT}`,
  );
  await expect
    .poll(() =>
      statusIndicator.evaluate((element) => getComputedStyle(element).fontSize),
    )
    .toBe("14px");
  await expect
    .poll(() =>
      statusIndicator.locator("[aria-hidden='true']").evaluate((element) => ({
        height: getComputedStyle(element).height,
        width: getComputedStyle(element).width,
      })),
    )
    .toEqual({ height: "14px", width: "14px" });
  await expect(statusIndicator.locator("[title]")).toHaveCount(0);
  await statusIndicator.hover();
  await expect(page.getByRole("tooltip")).toHaveText(STATUS_TEXT);
});
