import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, type Locator, type Page } from "@playwright/test";
import { finalizeEvent } from "nostr-tools/pure";

import type { RelayEvent } from "../../src/shared/api/types";
import { waitForAnimations } from "../helpers/animations";
import { TEST_IDENTITIES } from "../helpers/bridge";

export const GATE_B_DIRECTORY = path.resolve("test-results/blocks/gate-b");
const CORE_BLOCK_PATH = "../../../crates/buzz-relay/src/core_blocks/composites";

export const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
export const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";
export const OWNER_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
export const AGENT_PUBKEY = TEST_IDENTITIES.charlie.pubkey;

export const CORE_HANDLES = [
  "lead-card",
  "approval",
  "agent-proposal",
  "report",
  "artifact",
  "receipt",
  "brainstorm",
  "company-brief",
  "company-blueprint",
  "interview",
] as const;

export type CoreHandle = (typeof CORE_HANDLES)[number];

export type ManifestFixture = {
  schema: string;
  handle: string;
  version: string;
  name: string;
  description: string;
  origin: "core" | "installed" | "workspace-custom";
  created_at: number;
  input_schema: Record<string, unknown>;
  tree: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  fallback_template: string;
  supported_clients: string[];
  primitive_versions: Record<string, number>;
  examples: Array<Record<string, unknown>>;
  validation: Record<string, unknown>;
};

export type RawFeedItemFixture = {
  id: string;
  kind: number;
  pubkey: string;
  content: string;
  created_at: number;
  channel_id: string | null;
  channel_name: string;
  channel_type?: string | null;
  tags: string[][];
  category: "mention" | "needs_action" | "activity" | "agent_activity";
};

export type BlocksE2eWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
    channelName: string;
    content: string;
    pubkey?: string;
    kind?: number;
    extraTags?: string[][];
    parentEventId?: string | null;
    createdAt?: number;
    id?: string;
  }) => RelayEvent;
  __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
    channelName: string;
    event: RelayEvent;
  }) => RelayEvent;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
    kind?: number;
  }) => boolean;
  __BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?: (
    item: RawFeedItemFixture,
  ) => RawFeedItemFixture;
  __BUZZ_E2E_REPLACE_MOCK_BLOCK_EVENTS__?: (events: RelayEvent[]) => number;
  __BUZZ_E2E_CLEAR_MOCK_CHANNEL__?: (channelName: string) => boolean;
  __BUZZ_E2E_PUBLISHED_EVENTS__?: RelayEvent[];
  __BUZZ_E2E_COMMAND_LOG__?: Array<{
    command: string;
    payload: unknown;
  }>;
  __BUZZ_E2E_QUERY_CLIENT__?: {
    invalidateQueries: () => Promise<void>;
  };
  __BUZZ_E2E_SET_RELAY_CONNECTION_STATE__?: (
    state: "connected" | "connecting" | "disconnected" | "error",
  ) => void;
};

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Block fixtures cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported Block fixture value: ${typeof value}`);
}

export function readCoreManifest(handle: CoreHandle): ManifestFixture {
  const source = readFileSync(
    new URL(`${CORE_BLOCK_PATH}/${handle}.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(source) as ManifestFixture;
}

export function signManifest(
  manifest: ManifestFixture,
  identity: keyof typeof TEST_IDENTITIES = "tyler",
): RelayEvent {
  return finalizeEvent(
    {
      kind: 40012,
      created_at: manifest.created_at,
      tags: [["block", "1", manifest.handle, manifest.version]],
      content: canonicalJson(manifest),
    },
    hexToBytes(TEST_IDENTITIES[identity].privateKey),
  );
}

export function signCatalog(
  manifestEvent: RelayEvent,
  manifest: ManifestFixture,
): RelayEvent {
  return finalizeEvent(
    {
      kind: 30178,
      created_at: manifest.created_at + 1,
      tags: [
        ["d", manifest.handle],
        ["e", manifestEvent.id, "", "block-manifest"],
        ["block-state", "active"],
      ],
      content: canonicalJson({
        active_manifest_id: manifestEvent.id,
        handle: manifest.handle,
        origin: manifest.origin,
        permissions: manifest.permissions,
        preview: manifest.examples[0]?.data ?? {},
        schema: "ai-native-office/block-catalog-entry/v1",
        status: "active",
        summary: manifest.description,
      }),
    },
    hexToBytes(TEST_IDENTITIES.tyler.privateKey),
  );
}

export function trustedWorkspaceManifest(
  base: ManifestFixture,
  patch: Partial<ManifestFixture>,
): { manifest: ManifestFixture; events: RelayEvent[] } {
  const manifest = {
    ...structuredClone(base),
    ...patch,
    origin: "workspace-custom" as const,
  };
  const event = signManifest(manifest);
  return { manifest, events: [event, signCatalog(event, manifest)] };
}

export function blockTags({
  data,
  handle,
  instanceId,
  manifestId,
  processorPubkey,
  requiresAttention = false,
}: {
  data: unknown;
  handle: string;
  instanceId: string;
  manifestId: string;
  processorPubkey?: string;
  requiresAttention?: boolean;
}) {
  return [
    ["block", "1", handle, manifestId, instanceId],
    ["e", manifestId, "", "block"],
    ["block-data", canonicalJson(data)],
    ...(requiresAttention ? [["block-attention", "1", "required"]] : []),
    ...(processorPubkey ? [["p", processorPubkey]] : []),
  ];
}

export function signBlockInstance({
  channelId,
  content,
  data,
  handle,
  instanceId,
  manifestId,
  processorPubkey,
  requiresAttention = false,
  signer = "charlie",
}: {
  channelId: string;
  content: string;
  data: unknown;
  handle: string;
  instanceId: string;
  manifestId: string;
  processorPubkey?: string;
  requiresAttention?: boolean;
  signer?: keyof typeof TEST_IDENTITIES;
}): RelayEvent {
  return finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["h", channelId],
        ...blockTags({
          data,
          handle,
          instanceId,
          manifestId,
          processorPubkey,
          requiresAttention,
        }),
      ],
      content,
    },
    hexToBytes(TEST_IDENTITIES[signer].privateKey),
  );
}

export function externalBlockTags({
  byteSize,
  handle,
  instanceId,
  manifestId,
  processorPubkey,
  sha256,
  url,
}: {
  byteSize: number;
  handle: string;
  instanceId: string;
  manifestId: string;
  processorPubkey?: string;
  sha256: string;
  url: string;
}) {
  return [
    ["block", "1", handle, manifestId, instanceId],
    ["e", manifestId, "", "block"],
    ["block-data-ref", url, "application/json", sha256, String(byteSize)],
    ...(processorPubkey ? [["p", processorPubkey]] : []),
  ];
}

export function receiptTags({
  actionEventId,
  idempotencyKey,
  instanceEventId,
  instanceId,
  status,
  resolvesAttention = false,
}: {
  actionEventId: string;
  idempotencyKey: string;
  instanceEventId: string;
  instanceId: string;
  status: "succeeded" | "denied" | "failed" | "timed-out";
  resolvesAttention?: boolean;
}) {
  return [
    ["e", actionEventId, "", "block-action"],
    ["e", instanceEventId, "", "block-instance"],
    ["block-receipt", "1", instanceId, idempotencyKey, status],
    ...(resolvesAttention ? [["block-attention", "1", "resolved"]] : []),
  ];
}

export function signBlockAction({
  actionId,
  channelId,
  idempotencyKey,
  instanceEventId,
  instanceId,
  manifestId,
  processorPubkey,
}: {
  actionId: string;
  channelId: string;
  idempotencyKey: string;
  instanceEventId: string;
  instanceId: string;
  manifestId: string;
  processorPubkey: string;
}): RelayEvent {
  return finalizeEvent(
    {
      kind: 40010,
      created_at: Math.floor(Date.now() / 1_000) + 1,
      tags: [
        ["h", channelId],
        ["e", instanceEventId, "", "block-instance"],
        ["e", manifestId, "", "block-manifest"],
        ["p", processorPubkey],
        ["block-action", "1", actionId, instanceId, idempotencyKey],
      ],
      content: "{}",
    },
    hexToBytes(TEST_IDENTITIES.tyler.privateKey),
  );
}

export function signBlockReceipt({
  action,
  channelId,
  instanceEventId,
  instanceId,
  status,
}: {
  action: RelayEvent;
  channelId: string;
  instanceEventId: string;
  instanceId: string;
  status: "succeeded" | "denied" | "failed" | "timed-out";
}): RelayEvent {
  const parsed = action.tags.find((tag) => tag[0] === "block-action");
  if (!parsed?.[4]) throw new Error("Signed action fixture is malformed.");
  return finalizeEvent(
    {
      kind: 40011,
      created_at: action.created_at + 1,
      tags: [
        ["h", channelId],
        ...receiptTags({
          actionEventId: action.id,
          idempotencyKey: parsed[4],
          instanceEventId,
          instanceId,
          status,
        }),
      ],
      content: canonicalJson({ summary: `Action ${status}.` }),
    },
    hexToBytes(TEST_IDENTITIES.tyler.privateKey),
  );
}

export function fixtureUuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

export function compositeData(handle: CoreHandle, index = 1): unknown {
  switch (handle) {
    case "lead-card":
      return {
        company_id: `horizon-lead-${index}`,
        name: index === 1 ? "Tennant Group" : `Horizon Lead ${index}`,
        website: `https://example.com/lead-${index}`,
        fit_summary:
          "A credible US business whose current website undersells its expertise.",
        status: "qualified",
        score: 87,
        evidence: [
          "Established commercial reputation",
          "Current site undersells the work",
        ],
      };
    case "approval":
      return {
        action: "Send the approved outbound email",
        destination: "jordan@tennant-group.com",
        content:
          "Hi Jordan,\n\nWe rebuilt your homepage to show what Tennant Group can really do.",
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
        status: "pending",
      };
    case "agent-proposal":
      return {
        mode: "create",
        requestId: fixtureUuid(index),
        channelId: AGENTS_CHANNEL_ID,
        displayName: index === 1 ? "Researcher" : "QA Partner",
        systemPrompt:
          index === 1
            ? "Find and qualify US businesses while preserving source evidence."
            : "Review premium website rebuilds before client handoff.",
      };
    case "report":
      return {
        title: "Horizon growth report",
        summary: "Qualified pipeline and expected website-rebuild revenue.",
        headline_value: "$48,000",
        series: [
          { label: "Week 1", value: 8 },
          { label: "Week 2", value: 13 },
          { label: "Week 3", value: 21 },
        ],
        rows: [
          { label: "Qualified leads", value: 21 },
          { label: "Premium rebuilds", value: 6 },
          { label: "Expected revenue", value: "$48,000" },
        ],
        sources: ["CRM lead evidence", "Signed proposals"],
      };
    case "artifact":
      return {
        title: "Tennant Group homepage",
        description: "Premium website concept ready for review.",
        url: "https://assets.example/horizon-homepage.png",
        alt: "Premium dark editorial homepage concept",
        status: "ready-for-review",
      };
    case "receipt":
      return {
        receipt_id: `receipt-${index}`,
        status: "succeeded",
        summary: "Outbound email accepted by the responsible delivery bridge.",
        occurred_at: Math.floor(Date.now() / 1_000),
        references: ["a".repeat(64), "b".repeat(64)],
      };
    case "brainstorm":
      return {
        title: "Choose the homepage direction",
        prompt:
          "Select every direction worth exploring before Developer builds.",
        choices: [
          {
            id: "premium",
            label: "Premium editorial",
            description: "Strong typography and deliberate pacing.",
          },
          {
            id: "motion",
            label: "Cinematic motion",
            description: "Scroll-led transitions with restrained depth.",
          },
          {
            id: "conversion",
            label: "Conversion-led",
            description: "Clear proof, offer, and next action.",
          },
        ],
      };
    case "company-brief":
    case "company-blueprint":
    case "interview":
      return structuredClone(readCoreManifest(handle).examples[0]?.data ?? {});
  }
}

export async function waitForLiveChannel(
  page: Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelName, kind }) =>
          (window as BlocksE2eWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.(
            {
              channelName,
              kind,
            },
          ) ?? false,
        { channelName, kind },
      ),
    )
    .toBe(true);
}

export async function emitMessage(
  page: Page,
  input: Parameters<
    NonNullable<BlocksE2eWindow["__BUZZ_E2E_EMIT_MOCK_MESSAGE__"]>
  >[0],
) {
  return page.evaluate((message) => {
    const emit = (window as BlocksE2eWindow).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
    if (!emit) throw new Error("Mock message emitter is unavailable.");
    return emit(message);
  }, input);
}

export async function emitSignedEvent(
  page: Page,
  channelName: "agents" | "general",
  event: RelayEvent,
) {
  return page.evaluate(
    ({ channelName, event }) => {
      const emit = (window as BlocksE2eWindow).__BUZZ_E2E_EMIT_MOCK_EVENT__;
      if (!emit) throw new Error("Signed mock event emitter is unavailable.");
      return emit({ channelName, event });
    },
    { channelName, event },
  );
}

export async function pushFeedItem(page: Page, item: RawFeedItemFixture) {
  return page.evaluate((fixture) => {
    const push = (window as BlocksE2eWindow).__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__;
    if (!push) throw new Error("Mock feed emitter is unavailable.");
    return push(fixture);
  }, item);
}

export async function replaceBlockEvents(
  page: Page,
  events: RelayEvent[],
): Promise<number> {
  return page.evaluate((nextEvents) => {
    const replace = (window as BlocksE2eWindow)
      .__BUZZ_E2E_REPLACE_MOCK_BLOCK_EVENTS__;
    if (!replace)
      throw new Error("Mock Block event replacement is unavailable.");
    return replace(nextEvents);
  }, events);
}

export async function emitComposite(
  page: Page,
  {
    channelName = "general",
    data,
    handle,
    instanceId,
    manifestEvent,
    processorPubkey,
    pubkey = AGENT_PUBKEY,
    requiresAttention = false,
    text,
  }: {
    channelName?: "agents" | "general";
    data?: unknown;
    handle: CoreHandle;
    instanceId: string;
    manifestEvent: RelayEvent;
    processorPubkey?: string;
    pubkey?: string;
    requiresAttention?: boolean;
    text?: string;
  },
) {
  return emitMessage(page, {
    channelName,
    content:
      text ??
      `${handle} remains readable in chat if its richer inline view cannot render.`,
    extraTags: blockTags({
      data: data ?? compositeData(handle),
      handle,
      instanceId,
      manifestId: manifestEvent.id,
      processorPubkey,
      requiresAttention,
    }),
    kind: 9,
    pubkey,
  });
}

export async function openChannel(
  page: Page,
  channelName: "agents" | "general",
) {
  await page.goto("/");
  await page.getByTestId(`channel-${channelName}`).click();
  await expect(page.getByTestId("chat-title")).toHaveText(channelName);
  await waitForLiveChannel(page, channelName);
}

// Scroll to the floor and require it to still be the floor two frames later.
// Re-scrolling on every attempt is what makes this converge while rows are
// still landing, and measuring two frames after the scroll is what keeps it
// from being vacuous: anything that arrives in that window reopens the gap and
// the poll goes round again.
async function pinTimelineToFloor(timeline: Locator) {
  await expect
    .poll(() =>
      timeline.evaluate(
        (element) =>
          new Promise<number>((resolve) => {
            element.scrollTo({ behavior: "auto", top: element.scrollHeight });
            window.requestAnimationFrame(() =>
              window.requestAnimationFrame(() =>
                resolve(
                  Math.abs(
                    element.scrollHeight -
                      element.clientHeight -
                      element.scrollTop,
                  ),
                ),
              ),
            );
          }),
      ),
    )
    .toBeLessThanOrEqual(1);
}

export async function settleTimelineAtLatest(page: Page) {
  const timeline = page.getByTestId("message-timeline");
  const jumpToLatest = page.getByTestId("message-scroll-to-latest");
  await expect(timeline).toBeVisible();
  // Dismiss the pill before asserting anything about the floor, not after.
  //
  // "Jump to latest" is the control that admits the rows the timeline withheld
  // while it was reported off the bottom, and a timeline holding rows back
  // cannot be scrolled to a floor that those rows have not joined yet. The old
  // order gated the click on a floor assertion, so once the pill was up the
  // helper could only fail: it polled a floor it was not allowed to reach, and
  // the click that would have released it sat behind the poll. CI run
  // 33087235433 (Desktop Smoke E2E shard 1) is that exact state. It measured
  // 4275px off the floor for the entire 15s, and its failure screenshot has
  // the pill sitting in the corner of the timeline the whole time.
  //
  // The loop runs more than once because clearing the queue can admit rows
  // that arrived behind it and re-raise the pill. It is bounded rather than a
  // while-loop so a timeline that re-raises the pill forever fails the floor
  // assertion below with a real measurement instead of hanging until the test
  // times out somewhere unrelated.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await jumpToLatest.isVisible())) {
      break;
    }
    await jumpToLatest.click();
    await expect(jumpToLatest).toBeHidden();
    await pinTimelineToFloor(timeline);
  }
  await pinTimelineToFloor(timeline);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        );
      }),
  );
}

export function capture(
  page: Page,
  locator: Locator,
  filename: string,
): Promise<void> {
  return locator
    .evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    )
    .then(() => waitForAnimations(page))
    .then(async () => {
      await locator.screenshot({
        animations: "disabled",
        path: path.join(GATE_B_DIRECTORY, filename),
      });
    });
}

export function capturePage(page: Page, filename: string): Promise<void> {
  return waitForAnimations(page).then(async () => {
    await page.screenshot({
      animations: "disabled",
      path: path.join(GATE_B_DIRECTORY, filename),
    });
  });
}

export function createProofDirectory() {
  mkdirSync(GATE_B_DIRECTORY, { recursive: true });
}

export function assertDistinctScreenshots(filenames: readonly string[]) {
  const paths = filenames.map((filename) =>
    path.join(GATE_B_DIRECTORY, filename),
  );
  expect(
    paths.filter((screenshot) => !existsSync(screenshot)),
    "Every intended Gate B state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every intended Gate B state must produce distinct pixels.",
  ).toBe(hashes.length);
}

export function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

export async function setTextScale(page: Page, scale: 1 | 1.25) {
  await page.evaluate((nextScale) => {
    if (nextScale === 1) {
      window.localStorage.removeItem("buzz:text-scale");
      document.documentElement.style.fontSize = "";
    } else {
      window.localStorage.setItem("buzz:text-scale", String(nextScale));
      document.documentElement.style.fontSize = `${16 * nextScale}px`;
    }
  }, scale);
  await expect
    .poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    )
    .toBe(scale === 1 ? "16px" : "20px");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
