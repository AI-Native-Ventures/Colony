import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { emitSignedEvent, fixtureUuid, GENERAL_CHANNEL_ID, openChannel, OWNER_PUBKEY, settleTimelineAtLatest, signBlockInstance, signCatalog, signManifest } from "./blocks-test-helpers";

const manifest = JSON.parse(readFileSync(new URL("../../../crates/buzz-relay/src/core_blocks/composites/artifact.json", import.meta.url), "utf8"));

test("saved HTML artifact renders and expands with a contained mobile preview", async ({ page }, info) => {
  const signed = signManifest(manifest);
  await installMockBridge(page, { activeIdentityInDefaultChannels: true, blockEvents: [signed, signCatalog(signed, manifest)], relaySelf: OWNER_PUBKEY });
  await openChannel(page, "general");
  const event = signBlockInstance({ channelId: GENERAL_CHANNEL_ID, content: "Homepage layout", data: { title: "Homepage layout", description: "Static layout for review", url: "https://example.com/source.html", alt: "HTML source", status: "ready-for-review", revision: 1, preview_html: '<style>body{font-family:system-ui;padding:24px;background:#e1f4f0}h1{font-size:36px}</style><h1>First layout</h1><p>Saved inside this thread.</p><script>parent.document.body.innerHTML="COMPROMISED"</script>' }, handle: "artifact", instanceId: fixtureUuid(9201), manifestId: signed.id, processorPubkey: OWNER_PUBKEY });
  await emitSignedEvent(page, "general", event);
  await settleTimelineAtLatest(page);
  const preview = page.getByRole("region", { name: "Website preview", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.locator("iframe")).toHaveAttribute("sandbox", "");
  await expect(preview.frameLocator("iframe").getByRole("heading", { name: "First layout" })).toBeVisible();
  await expect(page.getByText("COMPROMISED", { exact: true })).toHaveCount(0);
  await waitForAnimations(page);
  await preview.screenshot({ path: info.outputPath("desktop-preview.png") });
  await preview.getByRole("button", { name: "Mobile", exact: true }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("title", "Mobile HTML preview");
  await preview.getByRole("button", { name: "Expand preview" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.frameLocator("iframe").getByRole("heading", { name: "First layout" })).toBeVisible();
  await waitForAnimations(page);
  await dialog.screenshot({ path: info.outputPath("expanded-mobile-preview.png") });
});
