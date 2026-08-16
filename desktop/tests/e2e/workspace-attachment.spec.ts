import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const ATTACHMENT_URL = `https://mock.relay/media/${"a".repeat(64)}.md`;

// The attachment bytes never touch disk: the tab fetches them over the same
// validated relay-media path the download action uses, which the mock bridge
// serves through `page.route` below.
test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDescriptors: [
      {
        url: ATTACHMENT_URL,
        sha256: "a".repeat(64),
        size: 24,
        type: "text/markdown",
        uploaded: Math.floor(Date.now() / 1000),
        filename: "handover.md",
      },
    ],
  });
  await page.route(ATTACHMENT_URL, (route) =>
    route.fulfill({
      body: "# Handover\n\nRead me in-app.",
      contentType: "text/markdown",
      status: 200,
    }),
  );
});

async function sendHandoverAttachment(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.from("# Handover\n\nRead me in-app."),
    mimeType: "text/markdown",
    name: "handover.md",
  });
  await expect(page.getByTestId("message-composer")).toContainText(
    "handover.md",
  );
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);
}

test("clicking an attachment card opens it as a workspace tab", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await sendHandoverAttachment(page);
  await page.getByTestId("file-card-open").last().click();

  await expect(page.getByTestId("channel-workspace")).toBeVisible();
  await expect(page.getByRole("tab", { name: "handover.md" })).toBeVisible();
  await expect(page.getByTestId("workspace-file-body")).toContainText(
    "Read me in-app.",
  );
});

test("download stays available beside the open action", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await sendHandoverAttachment(page);
  await page.getByTestId("file-card-download").last().click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
            .__BUZZ_E2E_COMMANDS__ ?? [],
      ),
    )
    .toContain("download_file");
  // Downloading is not reading: the workspace stays where it was.
  await expect(page.getByTestId("channel-workspace")).toHaveCount(0);
});
