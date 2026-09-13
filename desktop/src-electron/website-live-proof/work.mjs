// Real packaged UI and native agents. No mock bridge or injected job records.
import assert from "node:assert/strict";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForAnimations } from "../../tests/helpers/animations.ts";

/** First live gate: install, owner request, real brief, redesign and review. */
export async function runLiveWebsiteProof({
  page,
  account,
  proofDirectory,
  onProgress,
}) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        window.colonyDesktop.request("invoke", { command, args }),
      { command, args },
    );
  assert.equal((await invoke("get_identity")).pubkey, account.ownerPubkey);
  assert.equal(await invoke("get_relay_ws_url"), account.relayUrl);
  onProgress("installing-real-website-team");
  await page.getByTestId("open-agents-view").click();
  await page.getByTestId("install-website-manager-button").click();
  const dialog = page.getByTestId("website-team-install-dialog");
  await dialog.getByLabel("Website URL (optional)").fill("https://example.com");
  await dialog
    .getByLabel("What should they do?")
    .fill(
      "Redesign this single-page example website with clearer hierarchy, generous spacing and a responsive layout. Preserve the true Example Domain content. Use the Website Manager workflow and real original, desktop and mobile captures. Have the independent reviewer check the exact revision. Prepare a review for me; do not publish, buy a domain, send outreach, or change external accounts.",
    );
  await dialog
    .getByLabel("Channel", { exact: true })
    .selectOption(account.channelId);
  await dialog.getByTestId("website-team-install-submit").click();
  const openChannel = dialog.getByTestId("website-team-open-channel");
  await expect(openChannel).toBeEnabled({ timeout: 180_000 });
  await openChannel.click();
  await expect(dialog).toHaveCount(0);
  onProgress("sending-owner-request");
  const send = page.getByTestId("send-message").filter({ visible: true });
  await expect(send.first()).toBeEnabled();
  await send.first().click();
  const root = page.getByTestId("website-root-attachment").first();
  await expect(root).toBeVisible({ timeout: 600_000 });
  await waitForAnimations(page);
  await root.screenshot({
    path: path.join(proofDirectory, "website-live-brief.png"),
  });
  onProgress("owner-starting-redesign");
  await root
    .getByRole("button", { name: "Start redesign", exact: true })
    .click();
  await expect(
    root.getByRole("button", { name: "Start redesign", exact: true }),
  ).toHaveCount(0, { timeout: 60_000 });
  onProgress("waiting-for-real-redesign-review");
  // Review content must arrive from native agents; never seed a successful state.
  await expect(
    root.getByRole("region", { name: "Design review", exact: true }),
  ).toBeVisible({ timeout: 1_200_000 });
  await waitForAnimations(page);
  await root.screenshot({
    path: path.join(proofDirectory, "website-live-review.png"),
  });
  assert.equal((await invoke("get_identity")).pubkey, account.ownerPubkey);
  assert.equal(await invoke("get_relay_ws_url"), account.relayUrl);
  return {
    status: "review-reached",
    provider: "live-openrouter",
    source: "https://example.com",
    ownerPubkey: account.ownerPubkey,
    channelId: account.channelId,
    fullAcceptance: false,
    remaining: [
      "artifact-and-QA-evidence",
      "revision",
      "exact-version-approval",
      "handover",
      "reload-and-community-isolation",
    ],
  };
}
