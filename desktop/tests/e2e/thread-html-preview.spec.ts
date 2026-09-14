import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import {
  emitSignedEvent,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  settleTimelineAtLatest,
  signBlockInstance,
  signCatalog,
  signManifest,
} from "./blocks-test-helpers";

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/buzz-relay/src/core_blocks/composites/artifact.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("saved HTML artifact renders and expands with a contained mobile preview", async ({
  page,
}, info) => {
  const signed = signManifest(manifest);
  await installMockBridge(page, {
    activeIdentityInDefaultChannels: true,
    blockEvents: [signed, signCatalog(signed, manifest)],
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");
  const event = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Homepage layout",
    data: {
      title: "Homepage layout",
      description: "Static layout for review",
      url: "https://example.com/source.html",
      alt: "HTML source",
      status: "ready-for-review",
      revision: 1,
      preview_html:
        '<style>body{font-family:system-ui;padding:24px;background:#e1f4f0}h1{font-size:36px}</style><h1>First layout</h1><p>Saved inside this thread.</p><script>parent.document.body.innerHTML="COMPROMISED"</script>',
    },
    handle: "artifact",
    instanceId: fixtureUuid(9201),
    manifestId: signed.id,
    processorPubkey: OWNER_PUBKEY,
  });
  await emitSignedEvent(page, "general", event);
  await settleTimelineAtLatest(page);
  const preview = page.getByRole("region", {
    name: "Website preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(
    preview
      .frameLocator("iframe")
      .getByRole("heading", { name: "First layout" }),
  ).toBeVisible();
  await expect(page.getByText("COMPROMISED", { exact: true })).toHaveCount(0);
  await waitForAnimations(page);
  await preview.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: info.outputPath("desktop-preview.png") });
  await preview.getByRole("button", { name: "Mobile", exact: true }).click();
  await expect(preview.locator("iframe")).toHaveAttribute(
    "title",
    "Mobile HTML preview",
  );
  await preview.getByRole("button", { name: "Expand preview" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog
      .frameLocator("iframe")
      .getByRole("heading", { name: "First layout" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await dialog.screenshot({
    path: info.outputPath("expanded-mobile-preview.png"),
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const revision = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    parentEventId: event.id,
    content: "Updated layout after feedback",
    data: {
      title: "Homepage revision", description: "Updated heading", url: "https://example.com/revision-2.html", alt: "Revision 2 source", status: "ready-for-review", revision: 2, previous_artifact: event.id,
      preview_html: "<h1>Revised layout</h1><p>Your feedback is reflected here.</p>",
    },
    handle: "artifact", instanceId: fixtureUuid(9202), manifestId: signed.id, processorPubkey: OWNER_PUBKEY,
  });
  await emitSignedEvent(page, "general", revision);
  const summary = page.locator(
    `[data-testid="message-thread-summary"][data-thread-head-id="${event.id}"]`,
  );
  await expect(summary).toBeVisible();
  await summary.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await waitForAnimations(page);
  await summary.click();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
  await expect(page.frameLocator('section[aria-label="Website preview"]:has-text("Version 2") iframe').getByRole("heading", { name: "Revised layout" })).toBeVisible();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: info.outputPath("thread-revision.png") });

});
