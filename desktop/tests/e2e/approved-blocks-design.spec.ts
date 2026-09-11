import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DIAGRAM_EXAMPLES } from "../../src/shared/ui/diagram-preview/diagramExamples";
import { mediaFixtureRange } from "../helpers/mediaFixtureRange";
import { installMockBridge } from "../helpers/bridge";
import {
  emitSignedEvent,
  emitMessage,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  settleTimelineAtLatest,
  signBlockInstance,
  signCatalog,
  signManifest,
  waitForLiveChannel,
} from "./blocks-test-helpers";
import {
  approvedCoreManifests,
  assertApprovedFixture,
  captureApproved,
  expectApprovedBlock,
  installApprovedExampleMedia,
  openApprovedThread,
  seedApprovedAppearance,
} from "./approved-blocks-design.fixtures";

// Independent examples split across the existing smoke shards; one broken tree
// cannot hide the screenshots or results of the remaining catalogue entries.
test.describe.configure({ mode: "parallel", timeout: 60_000 });

test("an attached Mermaid file renders in the channel and thread and keeps its original source identity", async ({
  page,
}, info) => {
  await seedApprovedAppearance(page, "buzz-dark");
  const example = DIAGRAM_EXAMPLES[0];
  const filename = "diagram-flow.mmd";
  const url = `http://localhost:3000/media/${"f".repeat(64)}.mmd`;
  await page.route(url, (route) =>
    route.fulfill({
      contentType: "text/vnd.mermaid",
      body: example.source,
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await installMockBridge(page, { activeIdentityInDefaultChannels: true });
  await openChannel(page, "general");
  const event = await emitMessage(page, {
    channelName: "general",
    content: `[${filename}](${url})`,
    extraTags: [
      ["imeta", `url ${url}`, "m text/vnd.mermaid", `filename ${filename}`],
    ],
  });
  await settleTimelineAtLatest(page);
  const row = page.locator(`[data-message-id="${event.id}"]`).first();
  const preview = row.getByTestId("diagram-preview");
  await expect(preview).toBeVisible();
  await preview.scrollIntoViewIfNeeded();
  await expect(preview.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      preview
        .locator("img")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await captureApproved(page, preview, info, "diagram-file-dark-channel.png");
  const thread = await openApprovedThread(page, row);
  const narrow = thread.getByTestId("diagram-preview");
  await expect(narrow).toBeVisible();
  await narrow.scrollIntoViewIfNeeded();
  await expect(narrow.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      narrow
        .locator("img")
        .evaluate((node) => (node as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await narrow.getByRole("button", { name: "Source", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []))
    .toContainEqual({ command: "download_file", payload: { url, filename } });
  await captureApproved(page, narrow, info, "diagram-file-dark-thread.png");
});

for (const theme of ["buzz", "buzz-dark"] as const) {
  for (const [index, fixture] of approvedCoreManifests.entries()) {
    const { manifest } = fixture;
    test(`approved ${manifest.handle}: actual channel and thread in ${theme}`, async ({
      page,
    }, info) => {
      expect(approvedCoreManifests).toHaveLength(25);
      expect(
        new Set(approvedCoreManifests.map(({ manifest }) => manifest.handle))
          .size,
      ).toBe(25);
      assertApprovedFixture(manifest);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await seedApprovedAppearance(page, theme);
      await installApprovedExampleMedia(page);
      const signed = signManifest(manifest);
      await installMockBridge(page, {
        activeIdentityInDefaultChannels: true,
        blockEvents: [signed, signCatalog(signed, manifest)],
        relaySelf: OWNER_PUBKEY,
      });
      await openChannel(page, "general");
      const event = signBlockInstance({
        channelId: GENERAL_CHANNEL_ID,
        content: `Approved design example: ${manifest.name}`,
        data: manifest.examples[0]?.data ?? {},
        handle: manifest.handle,
        instanceId: fixtureUuid(1000 + index),
        manifestId: signed.id,
        processorPubkey: OWNER_PUBKEY,
      });
      await emitSignedEvent(page, "general", event);
      await settleTimelineAtLatest(page);
      const row = page
        .getByTestId("message-row")
        .filter({
          has: page.locator(`[data-block-handle="${manifest.handle}"]`),
        })
        .last();
      const channel = row.locator(`[data-block-handle="${manifest.handle}"]`);
      await expectApprovedBlock(channel);
      const channelProof = await captureApproved(
        page,
        channel,
        info,
        `${manifest.handle}-${theme}-channel.png`,
      );
      expect(channelProof.box?.width).toBeGreaterThan(500);
      const thread = await openApprovedThread(page, row);
      const narrow = thread.locator(`[data-block-handle="${manifest.handle}"]`);
      await expectApprovedBlock(narrow);
      const threadProof = await captureApproved(
        page,
        narrow,
        info,
        `${manifest.handle}-${theme}-thread.png`,
      );
      expect(threadProof.box?.width).toBeGreaterThan(220);
      expect(threadProof.box?.width).toBeLessThanOrEqual(500);
      expect(threadProof.sha256).not.toBe(channelProof.sha256);
      if (manifest.handle === "question") {
        await expect(narrow.getByRole("radio")).toHaveCount(3);
        await expect(
          narrow.getByRole("button", { name: "Submit", exact: true }),
        ).toBeDisabled();
        await narrow.getByRole("radio").first().check();
        await expect(narrow.getByRole("radio").first()).toBeChecked();
        await expect(
          narrow.getByRole("button", { name: "Submit", exact: true }),
        ).toBeEnabled();
        await expect(
          narrow.getByText("Reply in this thread", { exact: false }),
        ).toHaveCount(0);
      }
      if (manifest.handle === "interview") {
        await expect(narrow).toContainText("Question 3 of 6");
        await expect(narrow).toContainText(
          "Reply in this thread with your answer",
        );
        await expect(narrow.getByRole("radio")).toHaveCount(0);
        await expect(
          narrow.getByRole("button", { name: "Submit", exact: true }),
        ).toHaveCount(0);
        await expect(
          narrow.getByRole("button", { name: "I don't know", exact: true }),
        ).toBeVisible();
      }
      await info.attach("manifest-visual-proof.json", {
        body: Buffer.from(
          JSON.stringify(
            {
              handle: manifest.handle,
              version: manifest.version,
              source: fixture.source,
              sourceSha256: fixture.sha256,
              manifestEventId: signed.id,
              theme,
              fixtures:
                "Original manifest/example data; illustrative remote image bytes served from bundled launch artwork; mock native/relay bridge.",
              captures: [channelProof, threadProof],
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      expect(pageErrors).toEqual([]);
    });
  }
}

async function openApprovedExamples(
  page: Page,
  theme: "buzz" | "buzz-dark",
  tab: "Collections" | "Diagrams",
) {
  await seedApprovedAppearance(page, theme);
  await installMockBridge(page, { activeIdentityInDefaultChannels: true });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-buzz-theme", theme);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-blocks").click();
  await page.getByRole("tab", { name: "Examples", exact: true }).click();
  const gallery = page.getByTestId("rich-preview-gallery");
  await gallery.getByRole("tab", { name: tab, exact: true }).click();
  return gallery;
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test(`approved catalogue inventory has every source manifest and useful filters in ${theme}`, async ({
    page,
  }, info) => {
    await seedApprovedAppearance(page, theme);
    await installApprovedExampleMedia(page);
    const blockEvents = approvedCoreManifests.flatMap(({ manifest }) => {
      assertApprovedFixture(manifest);
      const event = signManifest(manifest);
      return [event, signCatalog(event, manifest)];
    });
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents,
      relaySelf: OWNER_PUBKEY,
    });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "data-buzz-theme",
      theme,
    );
    await page.getByTestId("open-settings").click();
    await page.getByTestId("profile-popover-settings").click();
    await page.getByTestId("settings-nav-blocks").click();
    await expect(
      page.getByRole("tab", { name: "Workspace", exact: true }),
    ).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("rich-preview-gallery")).toHaveCount(0);
    const catalog = page.getByTestId("blocks-workspace-catalog");
    const tiles = catalog.locator('[data-testid^="select-block-preview-"]');
    await expect(tiles).toHaveCount(25);
    expect(
      (
        await tiles.evaluateAll((nodes) =>
          nodes.map((node) =>
            node
              .getAttribute("data-testid")
              ?.replace("select-block-preview-", ""),
          ),
        )
      ).sort(),
    ).toEqual(
      approvedCoreManifests.map(({ manifest }) => manifest.handle).sort(),
    );
    await expect(catalog.locator("[data-block-catalog-handle]")).toHaveCount(1);
    await catalog.getByRole("button", { name: /^Composed\b/ }).click();
    await expect(tiles).toHaveCount(13);
    await catalog.getByRole("button", { name: /^Foundation\b/ }).click();
    await expect(tiles).toHaveCount(11);
    await catalog.getByRole("button", { name: /^Custom\b/ }).click();
    await expect(tiles).toHaveCount(0);
    await expect(catalog).toContainText("No Blocks match these filters.");
    await catalog.getByRole("button", { name: /^All\b/ }).click();
    await catalog
      .getByRole("searchbox", { name: "Search Blocks" })
      .fill("interview");
    await expect(tiles).toHaveCount(1);
    await tiles.click();
    const preview = catalog.getByRole("figure", {
      name: "Interview read-only preview",
    });
    await expect(preview).toContainText("What do you charge");
    await expect(preview).toContainText("Question 3 of 6");
    await captureApproved(
      page,
      catalog,
      info,
      `catalogue-search-interview-${theme}.png`,
    );
    await info.attach(`catalogue-inventory-${theme}.json`, {
      body: Buffer.from(
        JSON.stringify(
          approvedCoreManifests.map(({ source, sha256, manifest }) => ({
            source,
            sha256,
            handle: manifest.handle,
            name: manifest.name,
            version: manifest.version,
          })),
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
  });
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test(`approved documents keep independent PDF, workbook and CSV positions in ${theme}`, async ({
    page,
  }, info) => {
    const gallery = await openApprovedExamples(page, theme, "Collections");
    const pack = gallery.getByTestId(
      "rich-preview-example-collection-documents",
    );
    const choose = (filename: string) =>
      pack
        .getByRole("button", {
          name: new RegExp(
            `^View file \\d+: ${filename.replaceAll(".", "\\.")}$`,
          ),
        })
        .click();
    const preview = pack.getByTestId("inline-file-preview");
    await expect(preview).toHaveCount(1);
    await expect(preview.getByTestId("pdf-page-text")).toContainText(
      "SERVICE BUSINESS REPORT",
      { timeout: 20_000 },
    );
    await preview
      .getByRole("button", { name: "Next PDF page", exact: true })
      .click();
    await preview
      .getByRole("button", { name: "Zoom PDF in", exact: true })
      .click();
    await expect(preview.getByTestId("pdf-page-position")).toHaveText("2 / 2");
    await choose("client-brief.pdf");
    await expect(preview.getByTestId("pdf-page-position")).toHaveText("1 / 2");
    await expect(preview).toContainText("100%");
    await choose("service-ledger.xlsx");
    await expect(preview.getByTestId("file-preview-table")).toContainText(
      "R 1,250.00",
    );
    await preview
      .getByRole("combobox", { name: "Worksheet", exact: true })
      .selectOption({ label: "Summary" });
    await choose("service-ledger.csv");
    await expect(preview.getByTestId("file-preview-table")).toContainText(
      "Acme, Ltd",
    );
    await preview
      .getByRole("button", { name: "Next rows", exact: true })
      .click();
    await expect(preview).toContainText("Rows 26–33");
    await choose("service-ledger.xlsx");
    await expect(
      preview.getByRole("combobox", { name: "Worksheet", exact: true }),
    ).toHaveValue("1");
    const workbookProof = await captureApproved(
      page,
      pack,
      info,
      `collection-workbook-retained-${theme}.png`,
    );
    await choose("service-ledger.csv");
    await expect(preview).toContainText("Rows 26–33");
    const csvProof = await captureApproved(
      page,
      pack,
      info,
      `collection-csv-retained-${theme}.png`,
    );
    await choose("campaign-report.pdf");
    await expect(preview.getByTestId("pdf-page-position")).toHaveText("2 / 2");
    await expect(preview).toContainText("125%");
    await expect(preview.getByTestId("pdf-page-text")).toContainText(
      "NEXT WEEK",
    );
    await expect(pack.locator("canvas")).toHaveCount(1);
    const download = page.waitForEvent("download");
    await preview
      .getByRole("button", {
        name: "Download original campaign-report.pdf",
        exact: true,
      })
      .click();
    const original = await download;
    expect(original.suggestedFilename()).toBe("campaign-report.pdf");
    const bytes: Buffer[] = [];
    for await (const chunk of await original.createReadStream())
      bytes.push(Buffer.from(chunk));
    expect(
      Buffer.concat(bytes).equals(
        readFileSync(
          new URL(
            "../../public/rich-previews/service-report.pdf",
            import.meta.url,
          ),
        ),
      ),
    ).toBe(true);
    const pdfProof = await captureApproved(
      page,
      pack,
      info,
      `collection-documents-retained-${theme}.png`,
    );
    expect(
      new Set([workbookProof.sha256, csvProof.sha256, pdfProof.sha256]).size,
    ).toBe(3);
  });

  test(`approved video and mixed collections release inactive players in ${theme}`, async ({
    page,
  }, info) => {
    for (const [filename, contentType] of [
      ["preview-video.mp4", "video/mp4"],
      ["preview-audio.wav", "audio/wav"],
    ]) {
      const bytes = readFileSync(
        new URL(`../../public/rich-previews/${filename}`, import.meta.url),
      );
      await page.route(`**/rich-previews/${filename}`, (route) =>
        route.fulfill({
          ...mediaFixtureRange(bytes, route.request().headers().range),
          contentType,
        }),
      );
    }
    const gallery = await openApprovedExamples(page, theme, "Collections");
    const videos = gallery.getByTestId(
      "rich-preview-example-collection-videos",
    );
    const video = videos.locator("video");
    await expect(video).toHaveCount(1);
    await videos
      .getByRole("button", { name: "Play video", exact: true })
      .click();
    await expect(video).toHaveJSProperty("paused", false);
    await expect
      .poll(() =>
        video.evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThan(0.25);
    const previous = await video.elementHandle();
    if (!previous) throw new Error("The original video player was not mounted");
    const seconds = await previous.evaluate(
      (node) => (node as HTMLVideoElement).currentTime,
    );
    await videos
      .getByRole("button", {
        name: "View file 2: launch-cut-b.mp4",
        exact: true,
      })
      .click();
    expect(
      await previous.evaluate((node) => ({
        connected: node.isConnected,
        paused: (node as HTMLVideoElement).paused,
        source: node.getAttribute("src"),
      })),
    ).toEqual({ connected: false, paused: true, source: null });
    await expect(video).toHaveCount(1);
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("currentTime", 0);
    await videos
      .getByRole("button", {
        name: "View file 1: launch-cut-a.mp4",
        exact: true,
      })
      .click();
    await expect
      .poll(() =>
        video.evaluate((node) => (node as HTMLVideoElement).currentTime),
      )
      .toBeGreaterThanOrEqual(seconds);
    expect(
      await video.evaluate((node) => (node as HTMLVideoElement).currentTime),
    ).toBeLessThan(seconds + 1);
    await expect(video).toHaveJSProperty("paused", true);
    await captureApproved(
      page,
      videos,
      info,
      `collection-video-retained-${theme}.png`,
    );
    const mixed = gallery.getByTestId("rich-preview-example-collection-mixed");
    await expect(
      mixed.getByRole("button", { name: /^View file / }),
    ).toHaveCount(4);
    await expect(mixed).toContainText("Item 5: This attachment is unavailable");
    await mixed
      .getByRole("button", {
        name: "View file 3: launch-video.mp4",
        exact: true,
      })
      .click();
    await expect(mixed.locator("video,audio")).toHaveCount(1);
    await mixed
      .getByRole("button", { name: "View file 4: narration.wav", exact: true })
      .click();
    await expect(mixed.locator("video")).toHaveCount(0);
    await expect(mixed.locator("audio")).toHaveCount(1);
    await expect(mixed.locator("audio")).toHaveJSProperty("paused", true);
    await captureApproved(
      page,
      mixed,
      info,
      `collection-mixed-audio-${theme}.png`,
    );
  });

  for (const example of DIAGRAM_EXAMPLES) {
    test(`approved complex ${example.id} diagram renders and expands in ${theme}`, async ({
      page,
    }, info) => {
      const gallery = await openApprovedExamples(page, theme, "Diagrams");
      const exampleView = gallery.getByTestId(
        `rich-preview-example-diagram-${example.id}`,
      );
      await exampleView.scrollIntoViewIfNeeded();
      const preview = exampleView.getByTestId("diagram-preview");
      const image = preview.getByRole("img", {
        name: example.title,
        exact: true,
      });
      await expect(image).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(() =>
          image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      const rendered = await image.evaluate((node) => {
        const source = (node as HTMLImageElement).src;
        const svg = new DOMParser().parseFromString(
          decodeURIComponent(source.slice(source.indexOf(",") + 1)),
          "image/svg+xml",
        );
        return {
          text: svg.documentElement.textContent,
          viewBox: svg.documentElement.getAttribute("viewBox"),
          errors: svg.querySelectorAll("parsererror,script").length,
        };
      });
      expect(rendered.errors).toBe(0);
      expect(
        rendered.viewBox
          ?.split(/\s+/)
          .map(Number)
          .slice(2)
          .every((size) => size > 0),
      ).toBe(true);
      const labels =
        example.id === "flow"
          ? [
              "Client brief",
              "Owner decision",
              "Temporary failure",
              "Report results",
            ]
          : example.id === "sequence"
            ? ["Owner", "Designer", "Changes requested", "Approved"]
            : [
                "CLIENT",
                "PROJECT",
                "DELIVERABLE",
                "VERSION",
                "DECISION",
                "RECEIPT",
              ];
      for (const label of labels) expect(rendered.text).toContain(label);
      await preview.getByRole("button", { name: "200%", exact: true }).click();
      await expect(
        preview.getByRole("button", { name: "200%", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await preview.getByRole("button", { name: "Fit", exact: true }).click();
      await captureApproved(
        page,
        exampleView,
        info,
        `diagram-${example.id}-${theme}-inline.png`,
      );
      await preview
        .getByRole("button", { name: "Expand diagram", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("img", { name: example.title, exact: true }),
      ).toBeVisible();
      await captureApproved(
        page,
        dialog,
        info,
        `diagram-${example.id}-${theme}-expanded.png`,
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const sourceDownload = page.waitForEvent("download");
      await preview
        .getByRole("button", { name: "Source", exact: true })
        .click();
      const source = await sourceDownload;
      expect(source.suggestedFilename()).toBe(`diagram-${example.id}.mmd`);
      const chunks: Buffer[] = [];
      for await (const chunk of await source.createReadStream())
        chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(example.source);
      // The same complex source must also pass the ordinary message renderer.
      await page.getByTestId("settings-back-to-app").click();
      await expect(page.getByTestId("settings-view")).toHaveCount(0);
      await page.getByTestId("channel-general").click();
      await expect(page.getByTestId("chat-title")).toHaveText("general");
      await waitForLiveChannel(page, "general");
      const event = await emitMessage(page, {
        channelName: "general",
        content: `${example.title}\n\n\`\`\`mermaid\n${example.source}\n\`\`\``,
      });
      await settleTimelineAtLatest(page);
      const row = page.locator(`[data-message-id="${event.id}"]`).first();
      const messageDiagram = row.getByTestId("diagram-preview");
      await expect(messageDiagram).toHaveCount(1);
      await messageDiagram.scrollIntoViewIfNeeded();
      await expect(messageDiagram.locator("img")).toBeVisible();
      await expect
        .poll(() =>
          messageDiagram
            .locator("img")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await captureApproved(
        page,
        messageDiagram,
        info,
        `diagram-${example.id}-${theme}-channel.png`,
      );
      const thread = await openApprovedThread(page, row);
      const threadDiagram = thread.getByTestId("diagram-preview");
      await threadDiagram.scrollIntoViewIfNeeded();
      await expect(threadDiagram.locator("img")).toBeVisible();
      await expect
        .poll(() =>
          threadDiagram
            .locator("img")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      expect(
        await threadDiagram.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
      const narrowProof = await captureApproved(
        page,
        threadDiagram,
        info,
        `diagram-${example.id}-${theme}-thread.png`,
      );
      expect(narrowProof.box?.width).toBeLessThanOrEqual(500);
    });
  }
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test(`malformed SVG has a safe original-preserving fallback in ${theme}`, async ({
    page,
  }, info) => {
    await seedApprovedAppearance(page, theme);
    const fixture = approvedCoreManifests.find(
      ({ manifest }) => manifest.handle === "media",
    );
    if (!fixture)
      throw new Error("Core media manifest missing from relay inventory");
    const signed = signManifest(fixture.manifest);
    const url = "http://localhost:3000/media/invalid.svg";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__APPROVED_SVG_EXECUTED__=true</script><broken></svg>',
        headers: {
          "content-security-policy": "default-src 'none'",
          "x-content-type-options": "nosniff",
        },
      }),
    );
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: [signed],
      relaySelf: OWNER_PUBKEY,
    });
    await openChannel(page, "general");
    const event = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: "Malformed SVG preview",
      data: { url, alt: "Unavailable artwork" },
      handle: "media",
      instanceId: fixtureUuid(2000),
      manifestId: signed.id,
    });
    await emitSignedEvent(page, "general", event);
    await settleTimelineAtLatest(page);
    const block = page
      .locator(`[data-message-id="${event.id}"] [data-block-handle="media"]`)
      .first();
    await expect(block).toContainText("Image preview unavailable");
    await expect(block.locator("iframe,object,embed,script")).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __APPROVED_SVG_EXECUTED__?: boolean })
            .__APPROVED_SVG_EXECUTED__,
      ),
    ).toBeUndefined();
    await block
      .getByRole("button", { name: "Download invalid.svg", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []),
      )
      .toContainEqual({
        command: "download_file",
        payload: { url, filename: "invalid.svg" },
      });
    await captureApproved(page, block, info, `svg-safe-fallback-${theme}.png`);
  });
}
