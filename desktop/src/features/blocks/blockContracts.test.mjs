import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  BLOCK_PRIMITIVE_HANDLES,
  BLOCK_SCHEMA_DRAFT_2020_12,
} from "./contracts.ts";
import { loadBlockData } from "./blockData.ts";
import {
  isBlockMessage,
  parseBlockAction,
  parseBlockInstance,
  parseBlockReceipt,
} from "./blockTags.ts";
import {
  BUNDLED_CORE_MANIFEST_DIGESTS,
  createBlockRepository,
  loadDefaultMemberRoles,
  resetBlockRepository,
} from "./blockRepository.ts";
import { relayClient } from "../../shared/api/relayClient.ts";
import { blockDataQueryKey, requireAvailableBlockResult } from "./hooks.ts";
import {
  blockJsonSha256,
  canonicalBlockJson,
  computeApprovalHash,
  normalizeBlockHandle,
  validateBlockData,
  validateBlockManifest,
} from "./blockValidation.ts";

const EVENT_A = "a".repeat(64);
const EVENT_B = "b".repeat(64);
const PUBKEY = "c".repeat(64);
const INSTANCE_ID = "018f47a0-5db0-7ab1-8c6a-73d5ac1a69b1";
const IDEMPOTENCY_KEY = "018f47a0-5db0-7ab1-8c6a-73d5ac1a69b2";

test("isBlockMessage keeps Block rendering scoped to stream events", () => {
  assert.equal(isBlockMessage({ kind: 9, tags: [["block", "1"]] }), true);
  assert.equal(isBlockMessage({ kind: 40010, tags: [["block", "1"]] }), false);
  assert.equal(isBlockMessage({ kind: 9, tags: [] }), false);
});

function objectSchema(properties = {}, required = []) {
  return {
    $schema: BLOCK_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function validManifest(overrides = {}) {
  return {
    schema: "ai-native-office.block-manifest/1",
    handle: "test-card",
    version: "1.2.3",
    name: "Test Card",
    description: "A deterministic desktop fixture",
    origin: "workspace-custom",
    created_at: 1_700_000_000,
    input_schema: objectSchema({ title: { type: "string" } }, ["title"]),
    tree: {
      type: "actions",
      controls: [
        {
          label: "Submit",
          interaction: {
            type: "signed",
            action_id: "test.submit",
            resolves_attention: true,
          },
        },
      ],
    },
    actions: [
      {
        id: "test.submit",
        label: "Submit",
        input_schema: objectSchema({ value: { type: "string" } }, ["value"]),
        interaction: {
          type: "signed",
          action_id: "test.submit",
          resolves_attention: true,
        },
        permissions: [],
      },
    ],
    permissions: [],
    fallback_template: "Test: {{title}}",
    supported_clients: ["desktop"],
    primitive_versions: { actions: 1 },
    examples: [{ name: "Default", data: { title: "Hello" } }],
    validation: { state: "tested", requires_attention: true },
    ...overrides,
  };
}

function emptyWorkspaceTrust() {
  return {
    memberRoles: new Map(),
    verifiedAgentOwners: new Map(),
    installedPublisherPubkeys: new Set(),
  };
}

function signedManifestEvent(manifest, secretKey = generateSecretKey()) {
  return finalizeEvent(
    {
      kind: 40012,
      created_at: manifest.created_at,
      tags: [["block", "1", manifest.handle, manifest.version]],
      content: canonicalBlockJson(manifest),
    },
    secretKey,
  );
}

test("block canonical JSON, handle, and approval hash match Rust goldens", () => {
  assert.equal(
    canonicalBlockJson({ z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } }),
    '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}',
  );
  assert.deepEqual(normalizeBlockHandle(" @Lead-Card "), {
    ok: true,
    value: "lead-card",
  });
  assert.equal(normalizeBlockHandle("9bad").ok, false);
  assert.equal(
    computeApprovalHash({
      action: "email.send",
      destination: "mailto:owner@example.com",
      content: { subject: "Intro", body: "Hello" },
      expires_at: 1_785_456_000,
    }),
    "15c0fae0965fb074722e07e8ccaf8a431ccb9328195c8fc3682e8d0a4f77f44c",
  );
});

test("block manifest validates fixed primitives and dynamic data", () => {
  const manifest = validateBlockManifest(validManifest());
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  assert.deepEqual(
    [...BLOCK_PRIMITIVE_HANDLES],
    [
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
    ],
  );
  assert.equal(validateBlockData(manifest.value, { title: "Valid" }).ok, true);
  assert.equal(validateBlockData(manifest.value, { title: 42 }).ok, false);

  const unknownPrimitive = validManifest({
    tree: { type: "iframe", src: "https://example.com" },
  });
  assert.equal(validateBlockManifest(unknownPrimitive).ok, false);
  const remoteRef = validManifest({
    input_schema: {
      $schema: BLOCK_SCHEMA_DRAFT_2020_12,
      $ref: "https://example.com/schema.json",
    },
  });
  assert.equal(validateBlockManifest(remoteRef).ok, false);
});

test("a local reference that resolves to nothing is rejected, not thrown", () => {
  const danglingRef = validManifest({
    input_schema: {
      $schema: BLOCK_SCHEMA_DRAFT_2020_12,
      type: "object",
      properties: { title: { $ref: "#/$defs/missing" } },
    },
  });
  const manifest = validateBlockManifest(danglingRef);
  assert.equal(manifest.ok, false);
  assert.match(manifest.message, /schema could not be evaluated/);

  // The same schema reaching validateBlockData through an already-trusted
  // manifest must also fail closed rather than escape as an exception.
  const trusted = validateBlockManifest(validManifest());
  assert.ok(trusted.ok);
  const data = validateBlockData(
    { ...trusted.value, input_schema: danglingRef.input_schema },
    { title: "Hello" },
  );
  assert.equal(data.ok, false);
});

test("Question manifests accept exactly one bounded static or data-backed option source", () => {
  const question = {
    type: "question",
    prompt: "Choose directions",
    mode: "multi-select",
    options_path: "/choices",
    min_selections: 1,
    max_selections: 12,
    allow_custom: true,
    require_custom_input: false,
    submit_action: "test.submit",
  };
  const dynamic = validManifest({
    input_schema: objectSchema(
      {
        choices: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "description"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
      ["choices"],
    ),
    tree: question,
    primitive_versions: { question: 1 },
    examples: [
      {
        name: "Default",
        data: {
          choices: [
            {
              id: "premium",
              label: "Premium editorial",
              description: "Restrained typography and art direction.",
            },
          ],
        },
      },
    ],
  });
  assert.equal(validateBlockManifest(dynamic).ok, true);
  const parsed = validateBlockManifest(dynamic);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(
      validateBlockData(parsed.value, {
        choices: [
          {
            id: "premium",
            label: "Premium editorial",
            description: "Restrained typography and art direction.",
          },
        ],
      }).ok,
      true,
    );
    assert.equal(
      validateBlockData(parsed.value, {
        choices: [
          {
            id: "premium",
            label: "Missing strict description",
          },
        ],
      }).ok,
      false,
    );
  }
  assert.equal(
    validateBlockManifest({
      ...dynamic,
      tree: {
        ...question,
        options: [{ id: "duplicate", label: "Duplicate source" }],
      },
    }).ok,
    false,
  );
  assert.equal(
    validateBlockManifest({
      ...dynamic,
      tree: {
        ...question,
        options_path: undefined,
        options: Array.from({ length: 13 }, (_, index) => ({
          id: `option-${index + 1}`,
          label: `Option ${index + 1}`,
        })),
      },
    }).ok,
    false,
  );
});

test("block manifest accepts every relay-bundled primitive and composite", async () => {
  const coreRoot = new URL(
    "../../../../crates/buzz-relay/src/core_blocks/",
    import.meta.url,
  );
  const handles = new Set();
  for (const directory of ["primitives", "composites"]) {
    const directoryUrl = new URL(`${directory}/`, coreRoot);
    for (const filename of await readdir(directoryUrl)) {
      if (!filename.endsWith(".json")) continue;
      const value = JSON.parse(
        await readFile(new URL(filename, directoryUrl), "utf8"),
      );
      const result = validateBlockManifest(value);
      assert.equal(result.ok, true, `${directory}/${filename}`);
      if (result.ok) {
        handles.add(result.value.handle);
        assert.equal(
          BUNDLED_CORE_MANIFEST_DIGESTS.has(blockJsonSha256(value)),
          true,
          `missing bundled digest for ${result.value.handle}`,
        );
      }
    }
  }
  assert.equal(handles.size, 24);
  for (const handle of BLOCK_PRIMITIVE_HANDLES) {
    assert.equal(handles.has(handle), true, `missing primitive ${handle}`);
  }
});

test("block presentation and signed interactions stay on separate trust paths", () => {
  const presentation = {
    id: "agent.review",
    label: "Review",
    interaction: { type: "presentation", surface: "agent-review" },
    permissions: [],
  };
  assert.equal(
    validateBlockManifest(
      validManifest({
        origin: "workspace-custom",
        tree: {
          type: "actions",
          controls: [
            {
              label: "Review",
              interaction: presentation.interaction,
            },
          ],
        },
        actions: [presentation],
        validation: { state: "tested", requires_attention: false },
      }),
    ).ok,
    false,
  );
  assert.equal(
    validateBlockManifest(
      validManifest({
        origin: "core",
        tree: {
          type: "actions",
          controls: [
            {
              label: "Review",
              interaction: presentation.interaction,
            },
          ],
        },
        actions: [presentation],
        validation: { state: "tested", requires_attention: false },
      }),
    ).ok,
    true,
  );

  const mismatched = validManifest();
  mismatched.actions[0].interaction.action_id = "other.action";
  assert.equal(validateBlockManifest(mismatched).ok, false);
});

test("block Agent Proposal contract rejects secret-bearing schemas", () => {
  const proposal = validManifest({
    handle: "agent-proposal",
    input_schema: objectSchema(
      {
        name: { type: "string" },
        api_key: { type: "string" },
      },
      ["name"],
    ),
    examples: [{ name: "Proposal", data: { name: "Scout" } }],
  });
  assert.equal(validateBlockManifest(proposal).ok, false);
});

test("block instance tags extract inline, external, and attention state", () => {
  const base = [
    ["e", EVENT_A, "", "block"],
    ["block", "1", "lead-card", EVENT_A, INSTANCE_ID],
    ["block-data", '{"name":"Tennant Group"}'],
  ];
  const parsed = parseBlockInstance(base);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.handle, "lead-card");
    assert.equal(parsed.value.attentionRequired, false);
    assert.deepEqual(parsed.value.data, {
      type: "inline",
      value: { name: "Tennant Group" },
    });
  }

  const attention = parseBlockInstance([
    ...base,
    ["p", PUBKEY],
    ["block-attention", "1", "required"],
  ]);
  assert.equal(attention.ok, true);
  if (attention.ok) {
    assert.equal(attention.value.attentionRequired, true);
    assert.equal(attention.value.decisionMakerPubkey, PUBKEY);
    assert.equal(attention.value.processorPubkey, PUBKEY);
  }
  const delegatedAttention = parseBlockInstance([
    ...base,
    ["p", PUBKEY],
    ["block-processor", "1", EVENT_B],
    ["block-attention", "1", "required"],
  ]);
  assert.equal(delegatedAttention.ok, true);
  if (delegatedAttention.ok) {
    assert.equal(delegatedAttention.value.decisionMakerPubkey, PUBKEY);
    assert.equal(delegatedAttention.value.processorPubkey, EVENT_B);
  }
  assert.equal(
    parseBlockInstance([...base, ["block-attention", "1", "required"]]).ok,
    false,
  );
  assert.equal(
    parseBlockInstance([
      ...base,
      ["p", PUBKEY],
      ["block-attention", "1", "required"],
      ["block-attention", "1", "required"],
    ]).ok,
    false,
  );
  assert.equal(
    parseBlockInstance([
      ...base,
      ["p", PUBKEY],
      ["block-processor", "1", EVENT_B],
      ["block-processor", "1", EVENT_A],
      ["block-attention", "1", "required"],
    ]).ok,
    false,
  );

  const external = parseBlockInstance([
    ["e", EVENT_A, "", "block"],
    ["block", "1", "report", EVENT_A, INSTANCE_ID],
    [
      "block-data-ref",
      "https://public.example/report.json",
      "application/json",
      EVENT_B,
      "123",
    ],
  ]);
  assert.equal(external.ok, true);
  assert.equal(
    parseBlockInstance([
      ["e", EVENT_A, "", "block"],
      ["block", "1", "report", EVENT_A, INSTANCE_ID],
      [
        "block-data-ref",
        "http://public.example/report.json",
        "application/json",
        EVENT_B,
        "123",
      ],
    ]).ok,
    false,
  );
});

test("block data cache identity includes community, manifest event, and schema", () => {
  const request = {
    communityId: "company-a",
    manifestId: EVENT_A,
    manifest: validManifest(),
    data: { type: "inline", value: { title: "Same data" } },
  };
  const baseline = blockDataQueryKey(request);
  assert.notDeepEqual(
    blockDataQueryKey({ ...request, communityId: "company-b" }),
    baseline,
  );
  assert.notDeepEqual(
    blockDataQueryKey({ ...request, manifestId: EVENT_B }),
    baseline,
  );
  assert.notDeepEqual(
    blockDataQueryKey({
      ...request,
      manifest: {
        ...request.manifest,
        input_schema: objectSchema(
          {
            title: { type: "string" },
            priority: { type: "number" },
          },
          ["title"],
        ),
      },
    }),
    baseline,
  );
});

test("Block queries retry transient repository failures but preserve terminal fallbacks", () => {
  assert.throws(
    () =>
      requireAvailableBlockResult({
        ok: false,
        code: "unavailable",
        message: "rate-limited: quota exceeded; retry in 5s",
      }),
    /rate-limited/,
  );
  assert.deepEqual(
    requireAvailableBlockResult({
      ok: false,
      code: "invalid-manifest",
      message: "manifest contract is invalid",
    }),
    {
      ok: false,
      code: "invalid-manifest",
      message: "manifest contract is invalid",
    },
  );
});

test("block action and exact five-field receipt tags parse safely", () => {
  const action = parseBlockAction([
    ["p", PUBKEY],
    ["e", EVENT_A, "", "block-instance"],
    ["e", EVENT_B, "", "block-manifest"],
    ["block-action", "1", "question.submit", INSTANCE_ID, IDEMPOTENCY_KEY],
  ]);
  assert.equal(action.ok, true);

  const receiptTags = [
    ["e", EVENT_A, "", "block-action"],
    ["e", EVENT_B, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY_KEY, "succeeded"],
    ["block-attention", "1", "resolved"],
  ];
  const receipt = parseBlockReceipt(receiptTags);
  assert.equal(receipt.ok, true);
  if (receipt.ok) assert.equal(receipt.value.resolvesAttention, true);

  assert.equal(
    parseBlockReceipt(
      receiptTags.map((tag) =>
        tag[0] === "block-receipt" ? [...tag.slice(0, 4), "failed"] : tag,
      ),
    ).ok,
    false,
  );
  assert.equal(
    parseBlockReceipt([...receiptTags, ["block-attention", "1", "resolved"]])
      .ok,
    false,
  );
});

test("block external loader returns validation results instead of throwing", async () => {
  const parsed = validateBlockManifest(validManifest());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const loaded = await loadBlockData(
    parsed.value,
    {
      type: "external",
      url: "https://example.com/data.json",
      mime: "application/json",
      sha256: EVENT_A,
      byteSize: 17,
    },
    async () => new TextEncoder().encode('{"title":"Safe"}'),
  );
  assert.equal(loaded.ok, true);

  const invalid = await loadBlockData(
    parsed.value,
    {
      type: "external",
      url: "https://example.com/data.json",
      mime: "application/json",
      sha256: EVENT_A,
      byteSize: 1,
    },
    async () => Uint8Array.from([0xff]),
  );
  assert.deepEqual(invalid, {
    ok: false,
    code: "integrity-failed",
    message: "External Block data is not valid UTF-8",
  });

  let fetched = false;
  const insecure = await loadBlockData(
    parsed.value,
    {
      type: "external",
      url: "http://example.com/data.json",
      mime: "application/json",
      sha256: EVENT_A,
      byteSize: 17,
    },
    async () => {
      fetched = true;
      return new Uint8Array();
    },
  );
  assert.equal(insecure.ok, false);
  assert.equal(insecure.code, "invalid-tags");
  assert.equal(fetched, false);
});

test("block repository verifies signatures and coalesces community fetches", async () => {
  resetBlockRepository();
  const secretKey = generateSecretKey();
  const publisher = getPublicKey(secretKey);
  const event = signedManifestEvent(validManifest(), secretKey);
  let fetchCount = 0;
  const workspaceTrust = {
    ...emptyWorkspaceTrust(),
    memberRoles: new Map([[publisher, "owner"]]),
  };
  const repository = createBlockRepository({
    async fetchManifest() {
      fetchCount += 1;
      await Promise.resolve();
      return event;
    },
    async fetchActiveCatalog() {
      return null;
    },
    async relaySelf() {
      return null;
    },
    async workspaceTrust() {
      return workspaceTrust;
    },
  });
  const request = {
    communityId: "company-a",
    manifestId: event.id,
    workspaceTrust,
  };
  const [first, second] = await Promise.all([
    repository.load(request),
    repository.load(request),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(fetchCount, 1);
  if (first.ok) assert.equal(first.value.trust, "workspace-custom");

  const installed = await repository.load({
    communityId: "company-installed",
    manifestId: event.id,
    workspaceTrust: emptyWorkspaceTrust(),
    configuredPublisherPubkeys: new Set([publisher]),
  });
  assert.equal(installed.ok, true);
  if (installed.ok) assert.equal(installed.value.trust, "installed");

  const forged = { ...event, content: `${event.content} ` };
  const forgedRepository = createBlockRepository({
    async fetchManifest() {
      return forged;
    },
    async fetchActiveCatalog() {
      return null;
    },
    async relaySelf() {
      return null;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const invalid = await forgedRepository.load({
    communityId: "company-b",
    manifestId: event.id,
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "invalid-event");
});

test("default Block trust coalesces concurrent membership snapshot reads", async (t) => {
  resetBlockRepository();
  const relaySelf = "d".repeat(64);
  let fetchCount = 0;
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchRelease = new Promise((resolve) => {
    releaseFetch = resolve;
  });

  t.mock.method(relayClient, "fetchFirstEvent", async () => {
    fetchCount += 1;
    markFetchStarted();
    await fetchRelease;
    return null;
  });

  const first = loadDefaultMemberRoles(relaySelf);
  await fetchStarted;
  const second = loadDefaultMemberRoles(relaySelf);
  releaseFetch();

  const [firstRoles, secondRoles] = await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
  assert.equal(firstRoles, secondRoles);
  assert.equal(firstRoles.size, 0);
});

test("block repository requires relay key plus bundled digest for Core trust", async () => {
  resetBlockRepository();
  const source = await readFile(
    new URL(
      "../../../../crates/buzz-relay/src/core_blocks/primitives/section.json",
      import.meta.url,
    ),
    "utf8",
  );
  const manifest = JSON.parse(source);
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const event = signedManifestEvent(manifest, relaySecret);
  const repository = createBlockRepository({
    async fetchManifest() {
      return event;
    },
    async fetchActiveCatalog() {
      return null;
    },
    async relaySelf() {
      return relayPubkey;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const result = await repository.load({
    communityId: "company-core",
    manifestId: event.id,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.trust, "core");
});

test("block repository scopes relay catalog trust to the exact active target", async () => {
  resetBlockRepository();
  const authorSecret = generateSecretKey();
  const manifest = validManifest();
  const manifestEvent = signedManifestEvent(manifest, authorSecret);
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const catalogContent = {
    schema: "ai-native-office/block-catalog-entry/v1",
    handle: manifest.handle,
    active_manifest_id: manifestEvent.id,
    status: "active",
    summary: manifest.description,
    origin: "workspace-custom",
    preview: {},
    permissions: [],
  };
  const catalogEvent = finalizeEvent(
    {
      kind: 30178,
      created_at: manifest.created_at,
      tags: [
        ["d", manifest.handle],
        ["e", manifestEvent.id, "", "block-manifest"],
        ["block-state", "active"],
      ],
      content: canonicalBlockJson(catalogContent),
    },
    relaySecret,
  );
  const repository = createBlockRepository({
    async fetchManifest() {
      return manifestEvent;
    },
    async fetchActiveCatalog() {
      return catalogEvent;
    },
    async relaySelf() {
      return relayPubkey;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const active = await repository.load({
    communityId: "company-active",
    manifestId: manifestEvent.id,
  });
  assert.equal(active.ok, true);
  if (active.ok) assert.equal(active.value.trust, "workspace-custom");

  const unrelatedCatalog = {
    ...catalogEvent,
    tags: catalogEvent.tags.map((tag) =>
      tag[0] === "e" ? ["e", EVENT_A, "", "block-manifest"] : tag,
    ),
  };
  const unrelatedRepository = createBlockRepository({
    async fetchManifest() {
      return manifestEvent;
    },
    async fetchActiveCatalog() {
      return unrelatedCatalog;
    },
    async relaySelf() {
      return relayPubkey;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const unrelated = await unrelatedRepository.load({
    communityId: "company-unrelated",
    manifestId: manifestEvent.id,
  });
  assert.equal(unrelated.ok, true);
  if (unrelated.ok) assert.equal(unrelated.value.trust, "untrusted");
});

test("relay-signed active catalog grants Installed trust only to its exact target", async () => {
  resetBlockRepository();
  const authorSecret = generateSecretKey();
  const manifest = validManifest({ origin: "installed" });
  const manifestEvent = signedManifestEvent(manifest, authorSecret);
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const catalogEvent = finalizeEvent(
    {
      kind: 30178,
      created_at: manifest.created_at,
      tags: [
        ["d", manifest.handle],
        ["e", manifestEvent.id, "", "block-manifest"],
        ["block-state", "active"],
      ],
      content: canonicalBlockJson({
        schema: "ai-native-office/block-catalog-entry/v1",
        handle: manifest.handle,
        active_manifest_id: manifestEvent.id,
        status: "active",
        summary: manifest.description,
        origin: "installed",
        preview: {},
        permissions: [],
      }),
    },
    relaySecret,
  );
  const repository = createBlockRepository({
    async fetchManifest() {
      return manifestEvent;
    },
    async fetchActiveCatalog() {
      return catalogEvent;
    },
    async relaySelf() {
      return relayPubkey;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const active = await repository.load({
    communityId: "company-installed-active",
    manifestId: manifestEvent.id,
  });
  assert.equal(active.ok, true);
  if (active.ok) assert.equal(active.value.trust, "installed");

  const staleCatalog = {
    ...catalogEvent,
    tags: catalogEvent.tags.map((tag) =>
      tag[0] === "e" ? ["e", EVENT_A, "", "block-manifest"] : tag,
    ),
  };
  const staleRepository = createBlockRepository({
    async fetchManifest() {
      return manifestEvent;
    },
    async fetchActiveCatalog() {
      return staleCatalog;
    },
    async relaySelf() {
      return relayPubkey;
    },
    async workspaceTrust() {
      return emptyWorkspaceTrust();
    },
  });
  const stale = await staleRepository.load({
    communityId: "company-installed-stale",
    manifestId: manifestEvent.id,
  });
  assert.equal(stale.ok, true);
  if (stale.ok) assert.equal(stale.value.trust, "untrusted");
});
