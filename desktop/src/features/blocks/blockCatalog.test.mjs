import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  blockCatalogAddress,
  loadBlockCatalog,
  parseBlockCatalogEntry,
  parseBlockWorkshopDestination,
  resolveBlockCatalogHandoff,
  summarizeRecentBlockUsage,
} from "./blockCatalog.ts";
import { canonicalBlockJson } from "./blockValidation.ts";

const CHANNEL_ID = "018f47a0-5db0-7ab1-8c6a-73d5ac1a69b1";
const MANIFEST_ID = "a".repeat(64);
const INSTANCE_ID = "018f47a0-5db0-7ab1-8c6a-73d5ac1a69b2";

function catalogEvent(secretKey, overrides = {}) {
  const handle = overrides.handle ?? "lead-card";
  const manifestId = overrides.manifestId ?? MANIFEST_ID;
  const content = {
    schema: "ai-native-office/block-catalog-entry/v1",
    handle,
    active_manifest_id: manifestId,
    status: "active",
    summary: "A qualified opportunity.",
    origin: "core",
    preview: { name: "Tennant Group" },
    permissions: [],
    workshop: `buzz://message?channel=${CHANNEL_ID}&id=${"b".repeat(64)}`,
    ...overrides.content,
  };
  return finalizeEvent(
    {
      kind: 30178,
      created_at: overrides.createdAt ?? 1_700_000_000,
      tags: overrides.tags ?? [
        ["d", handle],
        ["e", manifestId, "", "block-manifest"],
        ["block-state", "active"],
      ],
      content: canonicalBlockJson(content),
    },
    secretKey,
  );
}

function manifestRecord(eventId = MANIFEST_ID) {
  return {
    event: {
      id: eventId,
      pubkey: "c".repeat(64),
      created_at: 1_700_000_000,
      kind: 40012,
      tags: [],
      content: "",
      sig: "d".repeat(128),
    },
    digest: "e".repeat(64),
    trust: "core",
    manifest: {
      schema: "ai-native-office.block-manifest/1",
      handle: "lead-card",
      version: "1.0.0",
      name: "Lead Card",
      description: "A qualified opportunity.",
      origin: "core",
      created_at: 1_700_000_000,
      input_schema: {},
      tree: { type: "section", title: "{{name}}" },
      actions: [],
      permissions: [],
      fallback_template: "{{name}}",
      supported_clients: ["desktop"],
      primitive_versions: { card: 1 },
      examples: [],
      validation: { state: "tested", requires_attention: false },
    },
  };
}

function usageEvent(secretKey, overrides = {}) {
  const channelId = overrides.channelId ?? CHANNEL_ID;
  return finalizeEvent(
    {
      kind: 9,
      created_at: overrides.createdAt ?? 1_700_000_100,
      tags: overrides.tags ?? [
        ["h", channelId],
        ["block", "1", "lead-card", MANIFEST_ID, INSTANCE_ID],
        ["e", MANIFEST_ID, "", "block"],
        ["block-data", "{}"],
      ],
      content: "Lead Card",
    },
    secretKey,
  );
}

test("catalog validates signed relay heads and rejects tag drift", () => {
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const event = catalogEvent(relaySecret);
  const parsed = parseBlockCatalogEntry(event, relayPubkey);
  assert.equal(parsed?.handle, "lead-card");
  assert.equal(parsed?.activeManifestId, MANIFEST_ID);

  const tampered = {
    ...event,
    tags: event.tags.map((tag) => (tag[0] === "d" ? ["d", "approval"] : tag)),
  };
  assert.equal(parseBlockCatalogEntry(tampered, relayPubkey), null);
});

test("catalog projects trusted manifests, addresses, and recent usage", async () => {
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const event = catalogEvent(relaySecret);
  const recentInstance = usageEvent(generateSecretKey());
  const items = await loadBlockCatalog(
    { communityId: "company", channelIds: [CHANNEL_ID] },
    {
      async fetchCatalogEvents() {
        return [event];
      },
      async fetchRecentMessages() {
        return { complete: true, events: [recentInstance] };
      },
      async loadManifest() {
        return { ok: true, value: manifestRecord() };
      },
      async relaySelf() {
        return relayPubkey;
      },
    },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.blockAddress, `30178:${relayPubkey}:lead-card`);
  assert.equal(items[0]?.manifestId, MANIFEST_ID);
  assert.deepEqual(items[0]?.recentUsage, {
    complete: true,
    count: 1,
    lastUsedAt: 1_700_000_100,
  });
});

test("catalog usage accepts only signed instances in the requested channels", () => {
  const signingKey = generateSecretKey();
  const valid = usageEvent(signingKey);
  const wrongChannel = usageEvent(signingKey, {
    channelId: "028f47a0-5db0-7ab1-8c6a-73d5ac1a69b1",
    createdAt: 1_700_000_101,
  });
  const forged = { ...valid, content: "tampered" };
  const usage = summarizeRecentBlockUsage(
    [valid, wrongChannel, forged],
    [CHANNEL_ID],
  );
  assert.deepEqual(usage.get("lead-card"), {
    count: 1,
    lastUsedAt: 1_700_000_100,
  });
  assert.equal(
    summarizeRecentBlockUsage(
      [
        finalizeEvent(
          {
            kind: 9,
            created_at: 10,
            tags: [["h", CHANNEL_ID]],
            content: "ordinary",
          },
          signingKey,
        ),
      ],
      [CHANNEL_ID],
    ).size,
    0,
  );
});

test("catalog exposes unavailable and partial usage without claiming an exact window", async () => {
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const event = catalogEvent(relaySecret);
  const dependencies = {
    async fetchCatalogEvents() {
      return [event];
    },
    async fetchRecentMessages() {
      return {
        complete: false,
        events: [usageEvent(generateSecretKey())],
      };
    },
    async loadManifest() {
      return { ok: true, value: manifestRecord() };
    },
    async relaySelf() {
      return relayPubkey;
    },
  };
  const partial = await loadBlockCatalog(
    { communityId: "company", channelIds: [CHANNEL_ID] },
    dependencies,
  );
  assert.deepEqual(partial[0]?.recentUsage, {
    complete: false,
    count: 1,
    lastUsedAt: 1_700_000_100,
  });

  const unavailable = await loadBlockCatalog(
    {
      communityId: "company",
      channelIds: [],
      recentUsageAvailable: false,
    },
    dependencies,
  );
  assert.deepEqual(unavailable[0]?.recentUsage, {
    complete: false,
    count: null,
    lastUsedAt: null,
  });
});

test("catalog usage ignores ordinary messages", () => {
  const usage = summarizeRecentBlockUsage([], [CHANNEL_ID]);
  assert.equal(usage.size, 0);
});

test("catalog workshop accepts signed deep-link destinations only", () => {
  const messageId = "b".repeat(64);
  const threadRootId = "c".repeat(64);
  assert.deepEqual(
    parseBlockWorkshopDestination(
      `buzz://message?channel=${CHANNEL_ID}&id=${messageId}&thread=${threadRootId}`,
    ),
    { channelId: CHANNEL_ID, messageId, threadRootId },
  );
  assert.deepEqual(parseBlockWorkshopDestination(CHANNEL_ID), {
    channelId: CHANNEL_ID,
  });
  assert.equal(
    parseBlockWorkshopDestination(`https://example.com/?channel=${CHANNEL_ID}`),
    null,
  );
});

test("catalog selection prefers a workshop and otherwise hands off to chat", () => {
  const workshopItem = {
    blockAddress: `30178:${"a".repeat(64)}:lead-card`,
    handle: "lead-card",
    manifestId: MANIFEST_ID,
    workshop: `buzz://message?channel=${CHANNEL_ID}&id=${"b".repeat(64)}`,
  };
  assert.deepEqual(resolveBlockCatalogHandoff(workshopItem), {
    kind: "workshop",
    channelId: CHANNEL_ID,
    messageId: "b".repeat(64),
  });
  assert.deepEqual(
    resolveBlockCatalogHandoff({ ...workshopItem, workshop: null }),
    {
      kind: "new-message",
      blockAddress: workshopItem.blockAddress,
      blockHandle: "lead-card",
      blockManifestId: MANIFEST_ID,
    },
  );
});

test("catalog address rejects non-canonical handles", () => {
  assert.equal(
    blockCatalogAddress("a".repeat(64), "lead-card"),
    `30178:${"a".repeat(64)}:lead-card`,
  );
  assert.equal(blockCatalogAddress("a".repeat(64), "Lead Card"), null);
});
