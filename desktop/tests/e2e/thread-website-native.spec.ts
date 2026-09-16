import { _electron as electron, expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import {
  emitSignedEvent,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  OWNER_PUBKEY,
  settleTimelineAtLatest,
  signBlockInstance,
  signCatalog,
  signManifest,
} from "./blocks-test-helpers";

// Real React card, preload, controller and native view. Fixture relay and bytes.
test("native website survives mobile and expanded mounts in the channel", async ({
  baseURL,
}, info) => {
  test.skip(
    process.env.COLONY_NATIVE_PREVIEW_PROOF !== "1",
    "Dedicated hosted Electron proof",
  );
  test.setTimeout(90_000);
  const handoverPath = info.outputPath("website-version-1.zip");
  const app = await electron.launch({
    env: { ...process.env, COLONY_PROOF_HANDOVER_PATH: handoverPath },
    args: [
      "--no-sandbox",
      fileURLToPath(
        new URL(
          "../../src-electron/website-preview/ui-proof-main.mjs",
          import.meta.url,
        ),
      ),
    ],
  });
  try {
    const page = await app.firstWindow();
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../crates/buzz-relay/src/core_blocks/composites/artifact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const signed = signManifest(manifest);
    // Mock relay transport still needs a real owner signature for approval.
    await page.addInitScript((identity) => {
      window.localStorage.setItem(
        "buzz:e2e-identity-override.v1",
        JSON.stringify(identity),
      );
    }, TEST_IDENTITIES.tyler);
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: [signed, signCatalog(signed, manifest)],
      relaySelf: OWNER_PUBKEY,
    });
    await page.goto(baseURL ?? "http://127.0.0.1:4173");
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");
    const event = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: "Saved website for review",
      handle: "artifact",
      instanceId: fixtureUuid(9301),
      manifestId: signed.id,
      processorPubkey: OWNER_PUBKEY,
      requiresAttention: true,
      data: {
        title: "Website design",
        description: "Review the saved website",
        url: "https://example.com/source.zip",
        alt: "Source files",
        status: "ready-for-review",
        revision: 1,
        website_bundle: {
          url: "https://example.com/manifest.json",
          sha256: "a".repeat(64),
        },
      },
    });
    await emitSignedEvent(page, "general", event);
    await settleTimelineAtLatest(page);
    const preview = page.getByRole("region", {
      name: "Saved website preview",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    const states = () =>
      app.evaluate(
        "[...globalThis.previewProof.host.byHandle.values()].map(e => ({viewport:e.viewport, width:e.layout?.cssWidth, visible:e.layout?.visible}))",
      );
    await expect.poll(async () => (await states()).length).toBe(1);
    await expect(preview.getByRole("status")).toHaveCount(0);
    await expect(
      preview.getByRole("button", { name: "Download website files" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Approve this design", exact: true })
      .click();
    const decision = () =>
      page.evaluate(() => {
        const events =
          (
            window as Window & {
              __BUZZ_E2E_PUBLISHED_EVENTS__?: Array<{
                kind: number;
                content: string;
                tags: string[][];
              }>;
            }
          ).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [];
        return events.find(
          (item) =>
            item.kind === 40010 &&
            item.tags.some(
              (tag) =>
                tag[0] === "block-action" &&
                tag[2] === "artifact.approve-design",
            ),
        );
      });
    await expect
      .poll(async () => (await decision())?.content)
      .toBe(
        JSON.stringify({
          manifest_sha256: "a".repeat(64),
          revision: 1,
          scope: "design-only",
        }),
      );
    expect((await decision())?.tags).toContainEqual([
      "e",
      event.id,
      "",
      "block-instance",
    ]);

    await expect(
      page.getByText("Design approved for this version. Not published.", {
        exact: true,
      }),
    ).toBeVisible();
    await preview
      .getByRole("button", { name: "Download website files" })
      .click();
    await expect
      .poll(() => app.evaluate("globalThis.previewProof.savedFilename"))
      .toBe("website-version-1.zip");
    const archive = unzipSync(readFileSync(handoverPath));
    const metadata = JSON.parse(
      Buffer.from(archive["colony-handover.json"]).toString("utf8"),
    );
    expect(metadata.artifactId).toBe(event.id);
    expect(metadata.revision).toBe(1);
    expect(metadata.manifestSha256).toBe("a".repeat(64));
    expect(Object.keys(archive).sort()).toEqual([
      "colony-handover.json",
      "source/project.zip",
      "website/index.html",
      "website/logo.svg",
      "website/site.css",
      "website/site.js",
    ]);
    const sourceArchive = archive["source/project.zip"];
    expect(createHash("sha256").update(sourceArchive).digest("hex")).toBe(
      metadata.sourceArchive.sha256,
    );
    expect(unzipSync(sourceArchive)["README.md"]).toBeDefined();
    await expect(
      preview.getByText(/verified project source archive/),
    ).toBeVisible();
    for (const file of metadata.files) {
      const bytes = archive[`website/${file.path}`];
      expect(bytes.length).toBe(file.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        file.sha256,
      );
    }

    await preview.getByRole("button", { name: "Mobile", exact: true }).click();
    await expect(
      preview.getByRole("button", { name: "Mobile", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => JSON.stringify(await states()))
      .toContain('"width":390');
    await preview.getByRole("button", { name: "Expand preview" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveCount(0);
    await expect.poll(async () => (await states()).length).toBe(1);
    await waitForAnimations(page);
    const png = await app.evaluate(async ({ desktopCapturer }) => {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (sources.length !== 1) throw new Error("Expected isolated CI display");
      return sources[0].thumbnail.toPNG().toString("base64");
    });
    writeFileSync(
      info.outputPath("native-expanded.png"),
      Buffer.from(png, "base64"),
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await states()).length).toBe(1);
    const revision = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      parentEventId: event.id,
      content: "Second saved revision",
      handle: "artifact",
      instanceId: fixtureUuid(9302),
      manifestId: signed.id,
      processorPubkey: OWNER_PUBKEY,
      data: {
        title: "Website revision",
        description: "Second immutable review entry",
        url: "https://example.com/source-2.zip",
        alt: "Revision source",
        status: "ready-for-review",
        revision: 2,
        previous_artifact: event.id,
        website_bundle: {
          url: "https://example.com/manifest-2.json",
          sha256: "a".repeat(64),
        },
      },
    });
    await emitSignedEvent(page, "general", revision);
    const summary = page.locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${event.id}"]`,
    );
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    const panel = page.getByTestId("message-thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Version 2", { exact: true })).toBeVisible();
    const revisionPreview = panel
      .getByRole("region", { name: "Saved website preview", exact: true })
      .filter({ hasText: "Version 2" });
    await expect(
      revisionPreview.getByRole("button", { name: "Download website files" }),
    ).toHaveCount(0);
    // The root appears in both channel and thread; each owns its own mount.
    await expect.poll(async () => (await states()).length).toBe(3);
    await panel
      .getByRole("button", { name: "Close panel", exact: true })
      .click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await states()).length).toBe(1);
    await page.getByTestId("channel-random").click();
    await expect.poll(async () => (await states()).length).toBe(0);
  } finally {
    await app.close();
  }
});
