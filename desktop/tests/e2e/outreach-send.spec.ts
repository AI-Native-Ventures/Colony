import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { seedApprovedAppearance } from "./approved-blocks-design.fixtures";
import {
  compositeData,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  readCoreManifest,
  signBlockAction,
  signBlockInstance,
  signBlockReceipt,
  signCatalog,
  signManifest,
} from "./blocks-test-helpers";

const PROOF_DIRECTORY = path.resolve("test-results/outreach-send");

// The owner approved the card, the desktop ran the Gmail journey, and the
// owner's own receipt came back. This is what the card looks like afterwards.
const SENT_RECEIPT = {
  outcome: "sent",
  sent_at: 1789084800,
  status_label: "sent",
  subject: "Winter boiler special for Sea Point homes",
  to: "info@atlanticplumb.co.za",
};

for (const [theme, suffix] of [
  ["buzz", "light"],
  ["buzz-dark", "dark"],
] as const) {
  test(`an approved outreach email reads as sent in ${suffix}`, async ({
    page,
  }) => {
    mkdirSync(PROOF_DIRECTORY, { recursive: true });
    await seedApprovedAppearance(page, theme);
    const source = readCoreManifest("outreach-email");
    const manifest = signManifest(source);
    const instanceId = fixtureUuid(910);
    const instance = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: "Email to Atlantic Plumbing",
      data: compositeData("outreach-email"),
      handle: "outreach-email",
      instanceId,
      manifestId: manifest.id,
      processorPubkey: OWNER_PUBKEY,
      requiresAttention: true,
    });
    const action = signBlockAction({
      actionId: "outreach.approve",
      channelId: GENERAL_CHANNEL_ID,
      idempotencyKey: fixtureUuid(911),
      instanceEventId: instance.id,
      instanceId,
      manifestId: manifest.id,
      processorPubkey: OWNER_PUBKEY,
    });
    const receipt = signBlockReceipt({
      action,
      channelId: GENERAL_CHANNEL_ID,
      content: SENT_RECEIPT,
      instanceEventId: instance.id,
      instanceId,
      resolvesAttention: true,
      status: "succeeded",
    });
    await installMockBridge(page, {
      activeIdentityInDefaultChannels: true,
      blockEvents: [manifest, signCatalog(manifest, source)],
      blockTimelineEvents: [instance, action, receipt].map((event) => ({
        channelName: "general",
        event,
      })),
      relaySelf: OWNER_PUBKEY,
    });
    await openChannel(page, "general");
    const block = page
      .locator(`[data-message-id="${instance.id}"]`)
      .locator('[data-block-handle="outreach-email"]');
    await expect(block).toBeVisible();
    const pill = block.locator('[data-block-primitive="status"]');
    // The receipt named the state it produced, so the pill says what happened
    // to the email rather than the generic "Completed".
    await expect(pill).toContainText("sent");
    await expect(pill).not.toContainText("pending");
    // Neither the pill nor the footer line falls back to the generic word.
    await expect(block).not.toContainText("Completed");
    await expect(block).toContainText("Sent.");
    // A resolved decision has no buttons left to press.
    await expect(block.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(block.getByRole("button", { name: "Skip" })).toHaveCount(0);
    await block.scrollIntoViewIfNeeded();
    await waitForAnimations(page);
    await block.screenshot({
      animations: "disabled",
      path: path.join(PROOF_DIRECTORY, `outreach-sent-${suffix}.png`),
    });
  });
}

test("the sent card is captured in two visibly different themes", async () => {
  const shots = ["outreach-sent-light.png", "outreach-sent-dark.png"].map(
    (name) => path.join(PROOF_DIRECTORY, name),
  );
  expect(
    shots.filter((shot) => !existsSync(shot)),
    "both theme captures must exist before they can be posted",
  ).toEqual([]);
  const hashes = shots.map((shot) =>
    createHash("sha256").update(readFileSync(shot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "light and dark must not be the same pixels",
  ).toBe(2);
});
