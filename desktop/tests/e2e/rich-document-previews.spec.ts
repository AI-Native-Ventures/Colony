import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const fixture = (name: string) =>
  readFileSync(new URL(`../../public/rich-previews/${name}`, import.meta.url));
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function openDocuments(page: Page) {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-blocks").click();
  await page
    .getByTestId("rich-preview-gallery")
    .getByRole("tab", { name: "Documents", exact: true })
    .click();
  return page.getByTestId("rich-preview-example");
}

async function captureDocument(
  page: Page,
  subject: Locator,
  info: TestInfo,
  name: string,
) {
  await waitForAnimations(page);
  await subject.screenshot({ path: info.outputPath(name) });
}

function documentCard(example: Locator, kind: string) {
  return example.locator(`[data-file-preview-kind="${kind}"]`);
}

async function expectOriginalDownload(
  page: Page,
  card: Locator,
  filename: string,
) {
  const pending = page.waitForEvent("download");
  await card
    .getByRole("button", { name: `Download original ${filename}`, exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(filename);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(digest(Buffer.concat(chunks))).toBe(digest(fixture(filename)));
}

test("real workbook and CSV show source values, keep navigation on expansion, and download original bytes", async ({
  page,
}, testInfo) => {
  const example = await openDocuments(page);
  const csv = documentCard(example, "csv");
  await csv.scrollIntoViewIfNeeded();
  await expect(csv.getByTestId("file-preview-table")).toContainText(
    "Acme, Ltd",
  );
  await captureDocument(page, csv, testInfo, "csv-original-values.png");
  await csv.getByRole("button", { name: "Next rows", exact: true }).click();
  await expect(csv).toContainText("Rows 26–33");
  await expectOriginalDownload(page, csv, "service-ledger.csv");

  const excel = documentCard(example, "excel");
  await excel.scrollIntoViewIfNeeded();
  await expect(excel.getByTestId("file-preview-table")).toContainText(
    "R 1,250.00",
  );
  await excel
    .getByRole("combobox", { name: "Worksheet", exact: true })
    .selectOption({ label: "Summary" });
  await expect(excel.getByTestId("file-preview-table")).toContainText(
    "Calculated value unavailable",
  );
  const inlineHeight = (await excel.boundingBox())?.height;
  await excel
    .getByRole("button", { name: "Expand service-ledger.xlsx", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  expect((await excel.boundingBox())?.height).toBeCloseTo(inlineHeight || 0, 0);
  await expect(
    dialog.getByRole("combobox", { name: "Worksheet", exact: true }),
  ).toHaveValue("1");
  await expect(dialog.getByTestId("file-preview-table")).toContainText(
    "R 52,400.00",
  );
  await captureDocument(page, dialog, testInfo, "expanded-document.png");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    excel.getByRole("combobox", { name: "Worksheet", exact: true }),
  ).toHaveValue("1");
  await expectOriginalDownload(page, excel, "service-ledger.xlsx");
});

test("PDF page and zoom survive expansion with readable real page text and original download", async ({
  page,
}, testInfo) => {
  const example = await openDocuments(page);
  const pdf = documentCard(example, "pdf");
  await pdf.scrollIntoViewIfNeeded();
  await expect(pdf.getByTestId("pdf-page-text")).toContainText(
    "SERVICE BUSINESS REPORT",
    { timeout: 20000 },
  );
  await pdf.getByRole("button", { name: "Next PDF page", exact: true }).click();
  await expect(pdf.getByTestId("pdf-page-text")).toContainText("NEXT WEEK");
  await pdf.getByRole("button", { name: "Zoom PDF in", exact: true }).click();
  await pdf
    .getByRole("button", { name: "Expand service-report.pdf", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("pdf-page-position")).toHaveText("2 / 2");
  await expect(dialog).toContainText("125%");
  await expect(dialog.getByTestId("pdf-page-text")).toContainText("NEXT WEEK");
  await captureDocument(page, dialog, testInfo, "expanded-document.png");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(pdf.getByTestId("pdf-page-position")).toHaveText("2 / 2");
  await expectOriginalDownload(page, pdf, "service-report.pdf");
});

test("failed file previews retain original download and narrow tables remain inside their pane", async ({
  page,
}, testInfo) => {
  await page.route("**/rich-previews/service-report.pdf", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  const example = await openDocuments(page);
  const pdf = documentCard(example, "pdf");
  await pdf.scrollIntoViewIfNeeded();
  await expect(pdf).toContainText("Preview unavailable");
  await expect(
    pdf.getByRole("button", {
      name: "Download original service-report.pdf",
      exact: true,
    }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  const csv = documentCard(example, "csv");
  await csv.scrollIntoViewIfNeeded();
  await expect(csv.getByTestId("file-preview-table")).toContainText(
    "Acme, Ltd",
  );
  await captureDocument(page, csv, testInfo, "csv-narrow-layout.png");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a CSV attachment uses the real message and thread renderer and native original-download command", async ({
  page,
}, testInfo) => {
  const bytes = fixture("service-ledger.csv");
  const url = `http://localhost:3000/media/${"d".repeat(64)}.csv`;
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDescriptors: [
      {
        url,
        sha256: "d".repeat(64),
        size: bytes.length,
        type: "text/csv",
        filename: "service-ledger.csv",
        uploaded: Math.floor(Date.now() / 1000),
      },
    ],
  });
  await page.route(url, (route) =>
    route.fulfill({ status: 200, contentType: "text/csv", body: bytes }),
  );
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach file", exact: true }).click();
  await (await chooser).setFiles({
    name: "service-ledger.csv",
    mimeType: "text/csv",
    buffer: bytes,
  });
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending", { exact: true })).toHaveCount(0);
  const card = page.getByTestId("file-card").last();
  await expect(card.getByTestId("file-preview-table")).toContainText(
    "Acme, Ltd",
  );
  const row = card.locator("xpath=ancestor::*[@data-message-id][1]");
  await row.hover();
  const reply = row.getByRole("button", { name: "Reply", exact: true });
  // A table can be taller than the timeline. The browser's nearest-edge
  // auto-scroll puts its top action bar under the header or composer overlay.
  // Focus keeps the normal hover/focus action bar exposed while we scroll its
  // control into the visible middle, then use a regular hit-tested click.
  await reply.focus();
  await reply.evaluate((button) =>
    button.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    }),
  );
  await reply.click();
  const thread = page.getByTestId("message-thread-head");
  await expect(thread.getByTestId("file-preview-table")).toContainText(
    "Acme, Ltd",
  );
  await captureDocument(page, thread, testInfo, "thread-csv-attachment.png");
  await thread
    .getByRole("button", {
      name: "Download original service-ledger.csv",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
            .__BUZZ_E2E_COMMANDS__ || [],
      ),
    )
    .toContain("download_file");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter(
          (entry) => entry.command === "download_file",
        ),
      ),
    )
    .toContainEqual({
      command: "download_file",
      payload: { url, filename: "service-ledger.csv" },
    });
});
