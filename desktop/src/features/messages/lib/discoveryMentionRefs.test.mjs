import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCOVERY_MENTION_TAG,
  extractDiscoveryReferenceTags,
  isValidDiscoveryReference,
  normalizeDiscoveryMention,
} from "./discoveryMentionRefs.ts";
import {
  extractTypedActorPubkeys,
  replaceWithDraftMentionRefs,
  routeTypedMentionReferences,
  snapshotDraftMentionRefs,
} from "./draftMentionRefs.ts";
import { buildDiscoveryMentionCandidates } from "./mentionCandidates.ts";

const CAMPAIGN_ID = "018f1a2b-0000-7000-8000-00000000c001";
const LEAD_ID = "018f1a2b-0000-7000-8000-00000000c002";

function refs(entries) {
  return new Map(entries);
}

test("selection validates the strict reference shapes", () => {
  assert.equal(
    isValidDiscoveryReference({
      discoveryKind: "campaign",
      entityId: CAMPAIGN_ID,
    }),
    true,
  );
  assert.equal(
    isValidDiscoveryReference({
      discoveryKind: "industry",
      entityId: "healthcare",
    }),
    true,
  );
  assert.equal(
    isValidDiscoveryReference({
      discoveryKind: "vertical",
      entityId: "healthcare/dentists",
    }),
    true,
  );
  // Vertical mentions must carry their parent industry.
  assert.equal(
    isValidDiscoveryReference({
      discoveryKind: "vertical",
      entityId: "dentists",
    }),
    false,
  );
  // Taxonomy ids are lowercase and slash-free; uuid kinds are uuids.
  assert.equal(
    isValidDiscoveryReference({
      discoveryKind: "industry",
      entityId: "Healthcare",
    }),
    false,
  );
  assert.equal(
    isValidDiscoveryReference({ discoveryKind: "lead", entityId: "abc" }),
    false,
  );
  assert.equal(
    isValidDiscoveryReference({ discoveryKind: "nope", entityId: LEAD_ID }),
    false,
  );
});

test("selecting a discovery result inserts readable text and binds one structured tag", () => {
  const normalized = normalizeDiscoveryMention("Sandton Dental", {
    discoveryKind: "lead",
    entityId: `${LEAD_ID} `,
  });
  assert.ok(normalized);
  assert.deepEqual(normalized, {
    displayName: "Sandton Dental",
    discoveryKind: "lead",
    entityId: LEAD_ID,
  });

  const rejected = normalizeDiscoveryMention("", {
    discoveryKind: "campaign",
    entityId: CAMPAIGN_ID,
  });
  assert.equal(rejected, null);

  const malformed = normalizeDiscoveryMention("x", {
    discoveryKind: "run",
    entityId: "not-a-uuid",
  });
  assert.equal(malformed, null);
});

test("tags are only emitted for tokens still present in the draft", () => {
  const tags = extractDiscoveryReferenceTags(
    "Work @Sandton Dental now, drop the rest",
    refs([
      ["Sandton Dental", { discoveryKind: "lead", entityId: LEAD_ID }],
      ["Ghost Campaign", { discoveryKind: "campaign", entityId: CAMPAIGN_ID }],
    ]),
  );
  assert.deepEqual(tags, [
    [DISCOVERY_MENTION_TAG, "lead", LEAD_ID, "Sandton Dental"],
  ]);
});

test("one tag per distinct entity even when mentioned twice", () => {
  const tags = extractDiscoveryReferenceTags(
    "@Gate C Lead twice: @Gate C Lead and again @Gate C Lead",
    refs([["Gate C Lead", { discoveryKind: "lead", entityId: LEAD_ID }]]),
  );
  assert.equal(tags.length, 1);
});

test("discovery references ride with block/cohort routing but add no p recipient", () => {
  const blockAddress = `30178:${"a".repeat(64)}:lead-card`;
  const cohortAddress = `30201:${"a".repeat(64)}:q3-leads`;
  const split = routeTypedMentionReferences(
    "@lead-card @Premium Q3 chase @Gate C Lead please",
    [],
    refs([["lead-card", { blockAddress, manifestId: "b".repeat(64) }]]),
    refs([["Premium Q3", { cohortAddress }]]),
    refs([["Gate C Lead", { discoveryKind: "lead", entityId: LEAD_ID }]]),
  );
  assert.deepEqual(split.actorPubkeys, []);
  assert.deepEqual(split.referenceTags, [
    ["a", blockAddress, "", "block"],
    ["a", cohortAddress, "", "cohort"],
    [DISCOVERY_MENTION_TAG, "lead", LEAD_ID, "Gate C Lead"],
  ]);
});

test("snapshots persist and restore structured discovery refs through drafts", () => {
  const discoveryMap = refs([
    [
      "Dentists",
      { discoveryKind: "vertical", entityId: "healthcare/dentists" },
    ],
  ]);
  const snapshot = snapshotDraftMentionRefs(
    "Follow up on @Dentists leads this week",
    refs([]),
    [],
    new Map(),
    new Map(),
    discoveryMap,
  );
  assert.deepEqual(snapshot, [
    {
      displayName: "Dentists",
      discoveryKind: "vertical",
      entityId: "healthcare/dentists",
    },
  ]);
});

test("restoring a draft rebuilds the discovery mention map", () => {
  const restored = new Map();
  const result = replaceWithDraftMentionRefs(
    [
      {
        displayName: "Dentists",
        discoveryKind: "vertical",
        entityId: "healthcare/dentists",
      },
    ],
    new Map(),
    new Map(),
    new Map(),
    new Map(),
    restored,
  );
  assert.deepEqual(result.names, ["Dentists"]);
  assert.deepEqual(
    [...restored.entries()],
    [
      [
        "Dentists",
        { discoveryKind: "vertical", entityId: "healthcare/dentists" },
      ],
    ],
  );
});

test("entity-owned tokens never leak into actor p recipients", () => {
  const candidates = [
    { displayName: "Acme Clinics", pubkey: "c".repeat(64), isMember: true },
  ];
  const pubkeys = extractTypedActorPubkeys(
    "Ping @Acme Clinics about their listing",
    refs([["Acme Clinics", "c".repeat(64)]]),
    candidates,
    new Map(),
    [],
    new Map(),
    refs([
      [
        "Acme Clinics",
        { discoveryKind: "campaign_leads", entityId: CAMPAIGN_ID },
      ],
    ]),
  );
  assert.deepEqual(pubkeys, []);
});

test("relay search rows build strict, deduplicated discovery candidates", () => {
  const built = buildDiscoveryMentionCandidates([
    { kind: "industry", id: "healthcare", label: "Healthcare" },
    { kind: "lead", id: LEAD_ID, label: "Gate C Lead", detail: "Johannesburg" },
    { kind: "lead", id: LEAD_ID, label: "Duplicate Row" },
    { kind: "aliens", id: "x", label: "Nope" },
    { kind: "campaign", id: CAMPAIGN_ID, label: "" },
  ]);
  assert.equal(built.length, 2);
  assert.deepEqual(built[0], {
    kind: "discovery",
    discoveryKind: "industry",
    entityId: "healthcare",
    contextId: undefined,
    detail: undefined,
    displayName: "Healthcare",
  });
});
