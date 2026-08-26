import { expect, test } from "@playwright/test";
import { verifyEvent } from "nostr-tools/pure";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import {
  AGENT_PUBKEY,
  AGENTS_CHANNEL_ID,
  assertDistinctScreenshots,
  capture,
  capturePage,
  compositeData,
  CORE_HANDLES,
  createProofDirectory,
  emitComposite,
  emitSignedEvent,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  openChannel,
  OWNER_PUBKEY,
  pushFeedItem,
  readCoreManifest,
  replaceBlockEvents,
  setTextScale,
  settleTimelineAtLatest,
  signBlockAction,
  signBlockInstance,
  signBlockReceipt,
  signCatalog,
  signManifest,
  trackPageErrors,
  trustedWorkspaceManifest,
  type BlocksE2eWindow,
} from "./blocks-test-helpers";

const COMPOSITE_SCREENSHOTS = CORE_HANDLES.map(
  (handle) => `composite-${handle}.png`,
);
const PRIMITIVE_SCREENSHOTS = ["primitive-card-list.png"] as const;
const LAYOUT_SCREENSHOTS = [
  "layout-1024-100.png",
  "layout-1024-125.png",
  "layout-1440-100.png",
  "layout-1440-125.png",
] as const;
const ACTION_SCREENSHOTS = [
  "approval-pending.png",
  "approval-completed.png",
] as const;
const PROPOSAL_SCREENSHOTS = [
  "proposal-pending-inline.png",
  "proposal-inbox-needs-action.png",
  "proposal-first-review.png",
  "proposal-second-review.png",
  "proposal-first-reopened.png",
  "proposal-failed.png",
  "proposal-retry-completed.png",
  "proposal-declined.png",
  "proposal-inbox-resolved.png",
] as const;
const VERSIONING_SCREENSHOTS = [
  "pinned-old-manifest.png",
  "pinned-new-manifest.png",
] as const;
const ISOLATION_SCREENSHOTS = [
  "isolation-a-before.png",
  "isolation-b-missing.png",
  "isolation-a-restored.png",
] as const;
const CATALOG_SCREENSHOTS = [
  "catalog-visible.png",
  "catalog-handoff-composer.png",
] as const;
const SCREENSHOTS = [
  ...COMPOSITE_SCREENSHOTS,
  ...PRIMITIVE_SCREENSHOTS,
  ...LAYOUT_SCREENSHOTS,
  ...ACTION_SCREENSHOTS,
  ...PROPOSAL_SCREENSHOTS,
  ...VERSIONING_SCREENSHOTS,
  ...ISOLATION_SCREENSHOTS,
  ...CATALOG_SCREENSHOTS,
] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(createProofDirectory);
test.afterAll(() => assertDistinctScreenshots(SCREENSHOTS));

test("all 11 native primitives and the 10 bundled composites render through MessageRow", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  const manifests = CORE_HANDLES.map((handle) =>
    signManifest(readCoreManifest(handle)),
  );
  const cardListManifest = trustedWorkspaceManifest(
    readCoreManifest("brainstorm"),
    {
      actions: [],
      created_at: readCoreManifest("brainstorm").created_at + 50,
      description: "Native Card List primitive coverage.",
      examples: [],
      fallback_template: "{{title}} — {{prompt}}",
      handle: "native-card-list",
      name: "Native Card List",
      permissions: [],
      primitive_versions: { card: 1, "card-list": 1 },
      tree: {
        type: "card-list",
        items_path: "/choices",
        card: {
          type: "card",
          title: "{{label}}",
          description: "{{description}}",
          children: [],
        },
      },
      version: "1.0.0",
    },
  );
  const cardListManifestEvent = cardListManifest.events[0];
  if (!cardListManifestEvent) {
    throw new Error("Card List manifest fixture is incomplete.");
  }
  await page.route("https://assets.example/**", (route) =>
    route.fulfill({
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      contentType: "image/png",
    }),
  );
  await installMockBridge(page, {
    blockEvents: [...manifests, ...cardListManifest.events],
    blockActionPublishDelayMs: 700,
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");

  const events = [];
  for (let index = 0; index < CORE_HANDLES.length; index += 1) {
    const handle = CORE_HANDLES[index];
    const event = signBlockInstance({
      channelId: GENERAL_CHANNEL_ID,
      content: `${handle} remains readable in chat if its richer inline view cannot render.`,
      data: compositeData(handle, index + 1),
      handle,
      instanceId: fixtureUuid(index + 1),
      manifestId: manifests[index].id,
      processorPubkey: OWNER_PUBKEY,
      requiresAttention: handle === "approval",
    });
    await emitSignedEvent(page, "general", event);
    events.push(event);
  }
  const cardListInstance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Native Card List remains readable in chat.",
    data: compositeData("brainstorm"),
    handle: "native-card-list",
    instanceId: fixtureUuid(12),
    manifestId: cardListManifestEvent.id,
  });

  for (let index = 0; index < CORE_HANDLES.length; index += 1) {
    const handle = CORE_HANDLES[index];
    const row = page.locator(`[data-message-id="${events[index].id}"]`);
    const block = row.locator(`[data-block-handle="${handle}"]`);
    await expect(block).toHaveAttribute("data-block-trust", "core");
    if (handle === "brainstorm") {
      await settleTimelineAtLatest(page);
    }
    await capture(page, block, COMPOSITE_SCREENSHOTS[index]);
  }
  await emitSignedEvent(page, "general", cardListInstance);
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  const cardListBlock = page
    .locator(`[data-message-id="${cardListInstance.id}"]`)
    .locator('[data-block-handle="native-card-list"]');
  await expect(cardListBlock).toHaveAttribute(
    "data-block-trust",
    "workspace-custom",
  );
  await capture(page, cardListBlock, "primitive-card-list.png");

  for (const primitive of [
    "section",
    "metric",
    "details",
    "table",
    "card",
    "card-list",
    "chart",
    "media",
    "status",
    "actions",
    "question",
  ]) {
    await expect(
      page.locator(`[data-block-primitive="${primitive}"]`).first(),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("img", { name: "Chart, line chart" }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Filter rows").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
  await expect(page.getByText("jordan@tennant-group.com")).toBeVisible();
  await expect(
    page.getByText(
      "Hi Jordan,\n\nWe rebuilt your homepage to show what Tennant Group can really do.",
      { exact: true },
    ),
  ).toBeVisible();

  const question = page.locator('[data-block-primitive="question"]');
  const premium = question.getByRole("button", {
    name: "Premium editorial",
  });
  await premium.focus();
  await page.keyboard.press("Space");
  await expect(premium).toHaveAttribute("aria-pressed", "true");
  const motion = question.getByRole("button", { name: "Cinematic motion" });
  await motion.focus();
  await page.keyboard.press("Enter");
  await expect(motion).toHaveAttribute("aria-pressed", "true");
  await question
    .getByLabel("Something else")
    .fill("Combine cinematic pacing with restrained editorial typography.");
  const submitAnswer = question.getByRole("button", { name: "Submit" });
  await expect(submitAnswer).toBeEnabled();
  await submitAnswer.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
            (event) =>
              event.kind === 40010 &&
              event.tags.some(
                (tag) =>
                  tag[0] === "block-action" && tag[2] === "brainstorm.submit",
              ),
          )?.content ?? null,
      ),
    )
    .toBe(
      '{"custom_input":"Combine cinematic pacing with restrained editorial typography.","selected":["premium","motion"]}',
    );
  await expect(
    question.getByRole("button", { name: "Answered" }),
  ).toBeDisabled();

  const approvalRow = page.locator(`[data-message-id="${events[1].id}"]`);
  await approvalRow.getByRole("button", { name: "Approve" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
            (event) =>
              event.kind === 40010 &&
              event.tags.some(
                (tag) =>
                  tag[0] === "block-action" && tag[2] === "approval.approve",
              ),
          ) ?? null,
      ),
    )
    .not.toBeNull();
  const action = await page.evaluate(
    () =>
      (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
        (event) =>
          event.kind === 40010 &&
          event.tags.some(
            (tag) => tag[0] === "block-action" && tag[2] === "approval.approve",
          ),
      ) ?? null,
  );
  if (!action) throw new Error("Approval action was not published.");
  const actionTag = action.tags.find((tag) => tag[0] === "block-action");
  if (!actionTag?.[3] || !actionTag[4]) {
    throw new Error("Approval action identity was not encoded.");
  }
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await expect(
    question.getByRole("button", { name: "Answered" }),
  ).toBeDisabled();
  await expect(approvalRow.getByText(/Action submitted/)).toBeVisible();
  await capture(
    page,
    approvalRow.locator('[data-block-handle="approval"]'),
    "approval-pending.png",
  );
  expect(errors).toEqual([]);
});

test("the visible Blocks catalog hands a typed Block reference into chat", async ({
  page,
}) => {
  const manifest = readCoreManifest("lead-card");
  const manifestEvent = signManifest(manifest);
  const catalogEvent = signCatalog(manifestEvent, manifest);
  const recentInstance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Recent catalog usage",
    data: compositeData("lead-card"),
    handle: "lead-card",
    instanceId: fixtureUuid(18),
    manifestId: manifestEvent.id,
  });
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page, {
    activeIdentityInDefaultChannels: true,
    blockEvents: [manifestEvent, catalogEvent],
    blockTimelineEvents: [{ channelName: "general", event: recentInstance }],
    relaySelf: OWNER_PUBKEY,
  });
  await page.goto("/");

  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await page.getByTestId("settings-nav-blocks").click();
  const catalogPage = page.getByTestId("blocks-catalog-page");
  const catalogCard = page.getByTestId("block-catalog-card-lead-card");
  await expect(catalogPage).toBeVisible();
  await expect(catalogCard).toContainText("@lead-card");
  // lead-card declares no permissions, so the row surfaces no capability ask.
  await expect(catalogCard).not.toContainText("Requires");
  await expect(catalogCard).not.toContainText("Active version");
  await expect(catalogCard).not.toContainText("Publisher");
  await expect(catalogCard).not.toContainText("Compatible clients");
  await expect(catalogCard).not.toContainText("At least 1 in recent sample");
  // The block itself is on screen: the preview renders its title.
  await expect(catalogCard).toContainText("Tennant Group");
  await expect(
    catalogCard.getByRole("figure", {
      name: `${manifest.name} read-only preview`,
    }),
  ).toBeVisible();
  await capture(page, catalogPage, "catalog-visible.png");

  await catalogCard.getByRole("button", { name: "Work in chat" }).click();
  await expect(page).toHaveURL(/\/messages\/new\?/);
  const composer = page.getByTestId("message-composer");
  const messageInput = page.getByTestId("message-input");
  await expect(composer).toBeVisible();
  await expect(messageInput).toContainText("Work on @lead-card");
  await page.getByTestId("new-dm-search").fill("charlie");
  await page
    .getByTestId(`new-dm-result-${TEST_IDENTITIES.charlie.pubkey}`)
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("new-message-recipient-popover")).toBeHidden();
  await capture(
    page,
    page.getByTestId("new-message-page"),
    "catalog-handoff-composer.png",
  );

  await page.getByTestId("send-message").click();
  const address = `30178:${OWNER_PUBKEY}:lead-card`;
  await expect
    .poll(() =>
      page.evaluate(
        ({ expectedContent }) => {
          const event = (
            (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? []
          ).find(
            (candidate) =>
              candidate.kind === 9 && candidate.content === expectedContent,
          );
          return event ?? null;
        },
        { expectedContent: "Work on @lead-card" },
      ),
    )
    .not.toBeNull();
  const sentEvent = await page.evaluate(
    ({ expectedContent }) => {
      const event = (
        (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? []
      ).find(
        (candidate) =>
          candidate.kind === 9 && candidate.content === expectedContent,
      );
      return event ?? null;
    },
    { expectedContent: "Work on @lead-card" },
  );
  expect(sentEvent).toMatchObject({
    kind: 9,
    pubkey: OWNER_PUBKEY,
    content: "Work on @lead-card",
  });
  expect(sentEvent?.tags).toContainEqual(["a", address, "", "block"]);
  expect(
    sentEvent
      ? verifyEvent({
          ...sentEvent,
          tags: sentEvent.tags,
        })
      : false,
  ).toBe(true);
});

test("a signed receipt completes its exact pinned approval", async ({
  page,
}) => {
  const manifest = signManifest(readCoreManifest("approval"));
  const instanceId = fixtureUuid(18);
  const instance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Completed approval remains durable in chat.",
    data: compositeData("approval", 18),
    handle: "approval",
    instanceId,
    manifestId: manifest.id,
    processorPubkey: OWNER_PUBKEY,
    requiresAttention: true,
  });
  const action = signBlockAction({
    actionId: "approval.approve",
    channelId: GENERAL_CHANNEL_ID,
    idempotencyKey: fixtureUuid(19),
    instanceEventId: instance.id,
    instanceId,
    manifestId: manifest.id,
    processorPubkey: OWNER_PUBKEY,
  });
  const receipt = signBlockReceipt({
    action,
    channelId: GENERAL_CHANNEL_ID,
    instanceEventId: instance.id,
    instanceId,
    status: "succeeded",
  });
  await installMockBridge(page, {
    blockEvents: [manifest],
    blockTimelineEvents: [instance, action, receipt].map((event) => ({
      channelName: "general",
      event,
    })),
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");
  const block = page
    .locator(`[data-message-id="${instance.id}"]`)
    .locator('[data-block-handle="approval"]');
  await expect(block.getByText("Completed.")).toBeVisible();
  await capture(page, block, "approval-completed.png");
});

test("blocks remain usable at both required window sizes and text scales", async ({
  page,
}) => {
  const manifest = signManifest(readCoreManifest("report"));
  await installMockBridge(page, {
    blockEvents: [manifest],
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");
  const event = await emitComposite(page, {
    handle: "report",
    instanceId: fixtureUuid(20),
    manifestEvent: manifest,
    processorPubkey: OWNER_PUBKEY,
  });
  const row = page.locator(`[data-message-id="${event.id}"]`);
  for (const [width, height] of [
    [1024, 720],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const scale of [1, 1.25] as const) {
      await setTextScale(page, scale);
      await expect(row.locator('[data-block-handle="report"]')).toBeVisible();
      await capturePage(page, `layout-${width}-${scale === 1 ? 100 : 125}.png`);
    }
  }
});

test("two independent Agent Proposals close, reopen, decline, and leave Needs action", async ({
  page,
}) => {
  const manifest = signManifest(readCoreManifest("agent-proposal"));
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page, {
    activeIdentityInDefaultChannels: true,
    agentProposalExecutionOutcomes: [
      {
        status: "failed",
        safe_message: "The local agent definition could not be applied.",
      },
      {
        status: "applied",
        definition_id: fixtureUuid(90),
        agent_pubkey: "9".repeat(64),
        recovered: false,
      },
    ],
    blockEvents: [manifest],
    globalAgentConfig: {
      env_vars: { OPENAI_COMPAT_API_KEY: "e2e-placeholder" },
      model: "gpt-5",
      preferred_runtime: "buzz-agent",
      provider: "openai",
    },
    relaySelf: OWNER_PUBKEY,
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Developer",
        channelNames: ["agents"],
        status: "running",
      },
    ],
  });
  await openChannel(page, "agents");

  const proposals = [1, 2].map((index) => {
    const instanceId = fixtureUuid(30 + index);
    return signBlockInstance({
      channelId: AGENTS_CHANNEL_ID,
      content: `Persistent Agent Proposal ${index}`,
      data: {
        ...(compositeData("agent-proposal", index) as Record<string, unknown>),
        requestId: instanceId,
      },
      handle: "agent-proposal",
      instanceId,
      manifestId: manifest.id,
      processorPubkey: OWNER_PUBKEY,
      requiresAttention: true,
    });
  });
  for (const proposal of proposals) {
    await emitSignedEvent(page, "agents", proposal);
    await pushFeedItem(page, {
      id: proposal.id,
      kind: proposal.kind,
      pubkey: proposal.pubkey,
      content: proposal.content,
      created_at: proposal.created_at,
      channel_id: AGENTS_CHANNEL_ID,
      channel_name: "agents",
      channel_type: "regular",
      tags: proposal.tags,
      category: "needs_action",
    });
  }
  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.getByTestId("home-inbox")).toBeVisible();
  await page.getByTestId("inbox-filter-trigger").click();
  await page.getByRole("menuitemradio", { name: "Needs action" }).click();
  await expect(
    page.getByTestId(`home-inbox-item-${proposals[0].id}`),
  ).toBeVisible();
  await expect(
    page.getByTestId(`home-inbox-item-${proposals[1].id}`),
  ).toBeVisible();
  await page.getByTestId("channel-agents").click();
  const rows = proposals.map((proposal) =>
    page.locator(`[data-message-id="${proposal.id}"]`),
  );
  await capture(
    page,
    rows[0].locator('[data-block-handle="agent-proposal"]'),
    "proposal-pending-inline.png",
  );
  await page.getByRole("button", { name: "Inbox" }).click();
  await page.getByTestId("inbox-filter-trigger").click();
  await page.getByRole("menuitemradio", { name: "Needs action" }).click();
  await capture(
    page,
    page.getByTestId("home-inbox-list"),
    "proposal-inbox-needs-action.png",
  );
  await page.getByTestId("channel-agents").click();
  await rows[0].getByRole("button", { name: "Review agent" }).click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog.getByLabel("Agent name")).toHaveValue("Researcher");
  await capture(page, dialog, "proposal-first-review.png");
  await page.keyboard.press("Escape");
  await rows[1].getByRole("button", { name: "Review agent" }).click();
  await expect(dialog.getByLabel("Agent name")).toHaveValue("QA Partner");
  await capture(page, dialog, "proposal-second-review.png");
  await page.keyboard.press("Escape");
  await rows[0].getByRole("button", { name: "Review agent" }).click();
  await expect(dialog.getByLabel("Agent name")).toHaveValue("Researcher");
  await dialog.getByLabel("Agent name").fill("Researcher retry");
  await capture(page, dialog, "proposal-first-reopened.png");
  await expect(dialog.getByTestId("persona-dialog-submit")).toBeEnabled();
  await dialog.getByTestId("persona-dialog-submit").click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
            (entry) => entry.command === "execute_agent_proposal",
          ).length,
      ),
    )
    .toBe(1);
  await expect(rows[0].getByText(/action failed/i)).toBeVisible();
  await capture(
    page,
    rows[0].locator('[data-block-handle="agent-proposal"]'),
    "proposal-failed.png",
  );
  const firstActionCreatedAt = await page.evaluate(
    () =>
      (window as BlocksE2eWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
        (event) => event.kind === 40010,
      )?.created_at ?? 0,
  );
  await expect
    .poll(() => Math.floor(Date.now() / 1_000))
    .toBeGreaterThan(firstActionCreatedAt);

  await rows[0].getByRole("button", { name: "Review agent" }).click();
  await dialog.getByLabel("Agent name").fill("Researcher recovered");
  await dialog.getByTestId("persona-dialog-submit").click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
            (entry) => entry.command === "execute_agent_proposal",
          ).length,
      ),
    )
    .toBe(2);
  await expect(rows[0].getByText("Completed.")).toBeVisible();
  await capture(
    page,
    rows[0].locator('[data-block-handle="agent-proposal"]'),
    "proposal-retry-completed.png",
  );

  await rows[1].getByRole("button", { name: "Review agent" }).click();
  await dialog.getByRole("button", { name: "Decline" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows[1].getByText("Declined.")).toBeVisible();
  await capture(
    page,
    rows[1].locator('[data-block-handle="agent-proposal"]'),
    "proposal-declined.png",
  );
  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(
    page.getByTestId(`home-inbox-item-${proposals[0].id}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`home-inbox-item-${proposals[1].id}`),
  ).toHaveCount(0);
  await capture(
    page,
    page.getByTestId("home-inbox-list"),
    "proposal-inbox-resolved.png",
  );
});

test("an old instance stays pinned when a newer workspace manifest becomes active", async ({
  page,
}) => {
  const base = readCoreManifest("lead-card");
  const handle = "pipeline-card";
  const old = trustedWorkspaceManifest(base, {
    actions: [],
    created_at: base.created_at + 100,
    description: "The first pinned pipeline presentation.",
    examples: [],
    fallback_template: "**{{name}}** — pinned pipeline v1",
    handle,
    name: "Pipeline Card",
    origin: "workspace-custom",
    permissions: [],
    primitive_versions: { card: 1, status: 1 },
    tree: {
      type: "card",
      title: "Pinned v1 — {{name}}",
      description: "This historical instance keeps its original presentation.",
      children: [
        { type: "status", label: "Pipeline state", state_path: "/status" },
      ],
    },
    version: "1.0.0",
  });
  const next = trustedWorkspaceManifest(base, {
    actions: [],
    created_at: base.created_at + 200,
    description: "The active pipeline presentation.",
    examples: [],
    fallback_template: "**{{name}}** — active pipeline v2",
    handle,
    name: "Pipeline Card",
    origin: "workspace-custom",
    permissions: [],
    primitive_versions: { card: 1, status: 1 },
    tree: {
      type: "card",
      title: "Active v2 — {{name}}",
      description: "New instances use the newly activated presentation.",
      children: [
        { type: "status", label: "Pipeline state", state_path: "/status" },
      ],
    },
    version: "2.0.0",
  });
  const oldManifestEvent = old.events[0];
  const nextManifestEvent = next.events[0];
  const nextCatalogEvent = next.events[1];
  if (!oldManifestEvent || !nextManifestEvent || !nextCatalogEvent) {
    throw new Error("Workspace manifest fixtures are incomplete.");
  }
  await installMockBridge(page, {
    blockEvents: old.events,
    relaySelf: OWNER_PUBKEY,
  });
  await openChannel(page, "general");

  const oldInstance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "The original pipeline card remains useful in plain text.",
    data: compositeData("lead-card", 101),
    handle,
    instanceId: fixtureUuid(101),
    manifestId: oldManifestEvent.id,
  });
  await emitSignedEvent(page, "general", oldInstance);
  const oldRow = page.locator(`[data-message-id="${oldInstance.id}"]`);
  await expect(oldRow.getByText("Pinned v1 — Horizon Lead 101")).toBeVisible();

  await replaceBlockEvents(page, [
    oldManifestEvent,
    nextManifestEvent,
    nextCatalogEvent,
  ]);
  const nextInstance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "The new pipeline card remains useful in plain text.",
    data: compositeData("lead-card", 102),
    handle,
    instanceId: fixtureUuid(102),
    manifestId: nextManifestEvent.id,
  });
  await emitSignedEvent(page, "general", nextInstance);
  const nextRow = page.locator(`[data-message-id="${nextInstance.id}"]`);
  await expect(nextRow.getByText("Active v2 — Horizon Lead 102")).toBeVisible();

  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await expect(oldRow.getByText("Pinned v1 — Horizon Lead 101")).toBeVisible();
  await expect(nextRow.getByText("Active v2 — Horizon Lead 102")).toBeVisible();
  await capture(
    page,
    oldRow.locator(`[data-block-handle="${handle}"]`),
    "pinned-old-manifest.png",
  );
  await capture(
    page,
    nextRow.locator(`[data-block-handle="${handle}"]`),
    "pinned-new-manifest.png",
  );
});

test("Block manifest and data state stay isolated across A to B to A", async ({
  page,
}) => {
  const communityA = {
    id: "blocks-gate-a",
    name: "Blocks A",
    relayUrl: "ws://localhost:3000",
    pubkey: "deadbeef".repeat(8),
    addedAt: "2026-07-30T20:00:00.000Z",
  };
  const communityB = {
    id: "blocks-gate-b",
    name: "Blocks B",
    relayUrl: "ws://localhost:3001",
    pubkey: "deadbeef".repeat(8),
    addedAt: "2026-07-30T20:01:00.000Z",
  };
  await page.addInitScript(
    ({ activeId, communities }) => {
      window.localStorage.setItem(
        "buzz-communities",
        JSON.stringify(communities),
      );
      window.localStorage.setItem("buzz-active-community-id", activeId);
    },
    { activeId: communityA.id, communities: [communityA, communityB] },
  );
  const manifest = signManifest(readCoreManifest("lead-card"));
  await installMockBridge(
    page,
    { blockEvents: [manifest], relaySelf: OWNER_PUBKEY },
    { skipCommunitySeed: true },
  );
  await openChannel(page, "general");

  const instance = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    content: "Community A pipeline evidence stays isolated.",
    data: compositeData("lead-card", 110),
    handle: "lead-card",
    instanceId: fixtureUuid(110),
    manifestId: manifest.id,
  });
  await emitSignedEvent(page, "general", instance);
  const row = page.locator(`[data-message-id="${instance.id}"]`);
  const rendered = row.locator('[data-block-handle="lead-card"]');
  await expect(rendered.getByText("Horizon Lead 110")).toBeVisible();
  await capture(page, rendered, "isolation-a-before.png");

  await replaceBlockEvents(page, []);
  await page.getByTestId(`community-rail-button-${communityB.id}`).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("buzz-active-community-id"),
      ),
    )
    .toBe(communityB.id);
  await page.getByTestId("channel-general").click();
  await expect(row.locator('[data-block-fallback="missing"]')).toBeVisible();
  await expect(rendered).toHaveCount(0);
  await capture(page, row, "isolation-b-missing.png");

  await replaceBlockEvents(page, [manifest]);
  await page.getByTestId(`community-rail-button-${communityA.id}`).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("buzz-active-community-id"),
      ),
    )
    .toBe(communityA.id);
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await expect(rendered.getByText("Horizon Lead 110")).toBeVisible();
  await capturePage(page, "isolation-a-restored.png");
});
