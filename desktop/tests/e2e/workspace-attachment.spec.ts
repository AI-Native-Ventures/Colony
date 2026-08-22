import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const RELAY_HTTP_ORIGIN = "http://localhost:3000";
const ATTACHMENT_URL = `${RELAY_HTTP_ORIGIN}/media/${"a".repeat(64)}.md`;
const PDF_ATTACHMENT_URL = `${RELAY_HTTP_ORIGIN}/media/${"b".repeat(64)}.pdf`;

// The attachment bytes never touch disk: the tab fetches them over the same
// validated relay-media path the download action uses, which the mock bridge
// serves through the per-fixture routes below.
async function installMarkdownAttachment(page: Page) {
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDescriptors: [
      {
        url: ATTACHMENT_URL,
        sha256: "a".repeat(64),
        size: 24,
        type: "application/octet-stream",
        uploaded: Math.floor(Date.now() / 1000),
        filename: "handover.md",
      },
    ],
  });
  await page.route(ATTACHMENT_URL, (route) =>
    route.fulfill({
      body: "# Handover\n\nRead me in-app.",
      contentType: "application/octet-stream",
      status: 200,
    }),
  );
}

function createBlankPdfBuffer() {
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n",
    ),
  ];
  const header = Buffer.from("%PDF-1.7\n% workspace fixture\n");
  const offsets: number[] = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 4\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size 4 /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return Buffer.concat([header, ...objects, xref]);
}

async function installPdfAttachment(page: Page, pdf: Buffer) {
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDescriptors: [
      {
        url: PDF_ATTACHMENT_URL,
        sha256: "b".repeat(64),
        size: pdf.length,
        type: "application/pdf",
        uploaded: Math.floor(Date.now() / 1000),
        filename: "board-pack.pdf",
      },
    ],
  });
  await page.route(PDF_ATTACHMENT_URL, (route) =>
    route.fulfill({
      body: pdf,
      contentType: "application/pdf",
      status: 200,
    }),
  );
}

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
  await installMarkdownAttachment(page);
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
  await installMarkdownAttachment(page);
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

test("a PDF attachment opens and renders inside the workspace", async ({
  page,
}) => {
  const pdf = createBlankPdfBuffer();
  await installPdfAttachment(page, pdf);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: pdf,
    mimeType: "application/pdf",
    name: "board-pack.pdf",
  });
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);
  await page.getByTestId("file-card-open").last().click();

  await expect(page.getByRole("tab", { name: "board-pack.pdf" })).toBeVisible();
  await expect(page.getByTestId("workspace-pdf-viewer")).toBeVisible();
  await expect(page.getByTestId("workspace-pdf-page-1")).toBeVisible();
  await expect(
    page.getByTestId("workspace-pdf-page-1").locator("canvas"),
  ).toBeVisible();
});
