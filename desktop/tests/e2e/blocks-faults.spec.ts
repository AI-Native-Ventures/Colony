import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import {
  assertDistinctScreenshots,
  blockTags,
  capture,
  canonicalJson,
  compositeData,
  createProofDirectory,
  emitMessage,
  emitSignedEvent,
  externalBlockTags,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  readCoreManifest,
  sha256Text,
  signBlockAction,
  signManifest,
  signBlockInstance,
  signBlockReceipt,
  trustedWorkspaceManifest,
} from "./blocks-test-helpers";

const FAULT_SCREENSHOTS = [
  "fault-missing.png",
  "fault-invalid-tags.png",
  "fault-unknown-primitive.png",
  "fault-untrusted.png",
  "fault-unsupported.png",
  "fault-oversized.png",
  "fault-hash-invalid.png",
  "fault-unavailable.png",
  "fault-permission-denied.png",
  "fault-offline-question.png",
  "fault-timed-out.png",
] as const;

test.describe.configure({ mode: "serial" });
test.beforeAll(createProofDirectory);
test.afterAll(() => assertDistinctScreenshots(FAULT_SCREENSHOTS));

test("missing, invalid, untrusted, unsupported, oversized, integrity, and unavailable inputs preserve safe text", async ({
  page,
}) => {
  const lead = readCoreManifest("lead-card");
  const leadEvent = signManifest(lead);
  const unknownManifest = {
    ...structuredClone(lead),
    version: "1.0.9",
    tree: { type: "unknown-primitive", children: [] },
    primitive_versions: { "unknown-primitive": 1 },
    examples: [],
  };
  const unknownEvent = signManifest(unknownManifest);
  const untrustedManifest = {
    ...structuredClone(lead),
    origin: "workspace-custom" as const,
    version: "1.1.0",
    created_at: lead.created_at + 10,
  };
  const untrustedEvent = signManifest(untrustedManifest, "outsider");
  const unsupported = trustedWorkspaceManifest(lead, {
    version: "1.2.0",
    created_at: lead.created_at + 20,
    supported_clients: ["mobile"],
  });
  const externalBody = canonicalJson(compositeData("lead-card", 70));
  const badHashUrl = "https://data.example/bad-hash.json";
  const unavailableUrl = "https://data.example/unavailable.json";
  await installMockBridge(page, {
    blockEvents: [
      leadEvent,
      unknownEvent,
      untrustedEvent,
      ...unsupported.events,
    ],
    blockDataResponses: {
      [badHashUrl]: { error: "Block data SHA-256 does not match declaration" },
      [unavailableUrl]: { error: "mock source unavailable" },
    },
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");

  const cases = [
    {
      name: "missing",
      content: "Missing manifest remains useful as text.",
      tags: blockTags({
        data: compositeData("lead-card", 61),
        handle: "lead-card",
        instanceId: fixtureUuid(61),
        manifestId: "1".repeat(64),
      }),
      state: "missing",
    },
    {
      name: "invalid-tags",
      content: "Malformed tags remain useful as text.",
      tags: [["block", "1", "lead-card"]],
      state: "invalid",
    },
    {
      name: "unknown-primitive",
      content: "Unknown primitive remains useful as text.",
      tags: blockTags({
        data: compositeData("lead-card", 63),
        handle: "lead-card",
        instanceId: fixtureUuid(63),
        manifestId: unknownEvent.id,
      }),
      state: "invalid",
    },
    {
      name: "untrusted",
      content: "Untrusted publisher remains useful as text.",
      tags: blockTags({
        data: compositeData("lead-card", 64),
        handle: "lead-card",
        instanceId: fixtureUuid(64),
        manifestId: untrustedEvent.id,
      }),
      state: "untrusted",
    },
    {
      name: "unsupported",
      content: "Unsupported client remains useful as text.",
      tags: blockTags({
        data: compositeData("lead-card", 65),
        handle: "lead-card",
        instanceId: fixtureUuid(65),
        manifestId: unsupported.events[0].id,
      }),
      state: "unsupported",
    },
    {
      name: "oversized",
      content: "Oversized inline data remains useful as text.",
      tags: blockTags({
        data: { padding: "x".repeat(70_000) },
        handle: "lead-card",
        instanceId: fixtureUuid(66),
        manifestId: leadEvent.id,
      }),
      state: "invalid",
    },
    {
      name: "hash-invalid",
      content: "Hash-invalid data remains useful as text.",
      tags: externalBlockTags({
        byteSize: Buffer.byteLength(externalBody),
        handle: "lead-card",
        instanceId: fixtureUuid(67),
        manifestId: leadEvent.id,
        sha256: "f".repeat(64),
        url: badHashUrl,
      }),
      explanation: "SHA-256 does not match declaration",
      state: "missing",
    },
    {
      name: "unavailable",
      content: "Unavailable external data remains useful as text.",
      tags: externalBlockTags({
        byteSize: Buffer.byteLength(externalBody),
        handle: "lead-card",
        instanceId: fixtureUuid(68),
        manifestId: leadEvent.id,
        sha256: sha256Text(externalBody),
        url: unavailableUrl,
      }),
      state: "missing",
    },
  ] as const;

  for (const fixture of cases) {
    await emitMessage(page, {
      channelName: "general",
      content: fixture.content,
      extraTags: fixture.tags,
      kind: 9,
    });
    // The "jump to latest" button unmounts the moment the timeline reaches the
    // bottom, so `isVisible()` then `click()` is a check-then-act race: the
    // button can detach between the two and the click then waits out the whole
    // test timeout. Ask for the outcome instead — the message on screen — and
    // treat the button as a best-effort nudge that is allowed to vanish.
    const jumpToLatest = page.getByTestId("message-scroll-to-latest");
    const messageText = page.getByText(fixture.content, { exact: true });
    await expect
      .poll(async () => {
        if ((await messageText.count()) > 0) return true;
        await jumpToLatest.click({ timeout: 1_000 }).catch(() => {});
        return (await messageText.count()) > 0;
      })
      .toBe(true);
    const message = page
      .locator("article")
      .filter({
        has: page.getByText(fixture.content, { exact: true }),
      })
      .last();
    const fallback = message.locator("[data-block-fallback]");
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute(
      "data-block-fallback",
      fixture.state,
    );
    await expect(fallback.getByText(fixture.content)).toBeVisible();
    if ("explanation" in fixture) {
      await expect(fallback).toContainText(fixture.explanation);
    }
    await capture(page, message, `fault-${fixture.name}.png`);
  }
});

test("permission denial, offline Question recovery, and timed-out receipts remain explicit", async ({
  page,
}) => {
  const approval = signManifest(readCoreManifest("approval"));
  const brainstorm = signManifest(readCoreManifest("brainstorm"));
  const lead = signManifest(readCoreManifest("lead-card"));
  const timedInstanceId = fixtureUuid(82);
  const timed = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "A timed-out action remains visible and retryable.",
    data: compositeData("lead-card", 82),
    handle: "lead-card",
    instanceId: timedInstanceId,
    manifestId: lead.id,
    processorPubkey: OWNER_PUBKEY,
  });
  const timedAction = signBlockAction({
    actionId: "lead.review",
    channelId: GENERAL_CHANNEL_ID,
    idempotencyKey: fixtureUuid(83),
    instanceEventId: timed.id,
    instanceId: timedInstanceId,
    manifestId: lead.id,
    processorPubkey: OWNER_PUBKEY,
  });
  const timedReceipt = signBlockReceipt({
    action: timedAction,
    channelId: GENERAL_CHANNEL_ID,
    instanceEventId: timed.id,
    instanceId: timedInstanceId,
    status: "timed-out",
  });
  await installMockBridge(page, {
    blockEvents: [approval, brainstorm, lead],
    blockTimelineEvents: [timed, timedAction, timedReceipt].map((event) => ({
      channelName: "general",
      event,
    })),
    blockActionPublishErrors: ["permission denied", "network offline"],
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");

  const approvalEvent = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Approval remains visible after a denied publish.",
    data: compositeData("approval", 80),
    handle: "approval",
    instanceId: fixtureUuid(80),
    manifestId: approval.id,
    processorPubkey: OWNER_PUBKEY,
    requiresAttention: true,
  });
  await emitSignedEvent(page, "general", approvalEvent);
  const approvalRow = page.locator(`[data-message-id="${approvalEvent.id}"]`);
  await approvalRow.getByRole("button", { name: "Approve" }).click();
  await expect(approvalRow.getByRole("alert")).toContainText(
    "permission denied",
  );
  await capture(
    page,
    approvalRow.locator('[data-block-handle="approval"]'),
    "fault-permission-denied.png",
  );

  const questionEvent = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Offline answers remain in the conversation.",
    data: compositeData("brainstorm", 81),
    handle: "brainstorm",
    instanceId: fixtureUuid(81),
    manifestId: brainstorm.id,
    processorPubkey: OWNER_PUBKEY,
  });
  await emitSignedEvent(page, "general", questionEvent);
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  const questionRow = page.locator(`[data-message-id="${questionEvent.id}"]`);
  await questionRow.getByRole("button", { name: "Premium editorial" }).click();
  await questionRow.getByRole("button", { name: "Submit" }).click();
  await expect(questionRow.getByText(/Saved offline/)).toBeVisible();
  await capture(
    page,
    questionRow.locator('[data-block-handle="brainstorm"]'),
    "fault-offline-question.png",
  );
  const timedRow = page.locator(`[data-message-id="${timed.id}"]`);
  await expect(timedRow.getByText(/timed out/)).toBeVisible();
  await capture(
    page,
    timedRow.locator('[data-block-handle="lead-card"]'),
    "fault-timed-out.png",
  );
});
