import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { canonicalCompanyJson } from "../company/contracts.ts";
import {
  parsePartyHead,
  parsePartyRelationshipHead,
  relationshipCoordinate,
} from "./contracts.ts";
import {
  createPartyRepository,
  MAX_ALIAS_HOPS,
  resetPartyRepositoryState,
} from "./partyRepository.ts";

const RELAY_SECRET = generateSecretKey();
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const IMPOSTOR_SECRET = generateSecretKey();

const PARTY = {
  schema: "colony.party/v1",
  id: "acme-industries",
  kind: "organization",
  displayName: "Acme Industries",
  legalName: null,
  identifiers: [
    { scheme: "domain", value: "acme.example", confidence: "asserted" },
  ],
  provenance: [
    {
      id: "prov-01",
      source: "discovery:google-maps",
      observedAt: 1_785_369_600,
      sourceRef: null,
      fields: ["displayName"],
    },
  ],
  retiredHandles: [],
  createdAt: 1_785_369_600,
  updatedAt: 1_785_369_600,
};

const LEAD = {
  schema: "colony.party-relationship/v1",
  id: "acme-industries:lead",
  partyId: "acme-industries",
  relationship: "lead",
  status: "qualified",
  ownerPersonaId: "company-role:abc:horizonlabs:sales-lead",
  sourceChannelId: "welcome",
  createdAt: 1_785_369_600,
  updatedAt: 1_785_369_600,
};

function head(
  kind,
  record,
  tags,
  secret = RELAY_SECRET,
  createdAt = 1_785_369_700,
) {
  return finalizeEvent(
    {
      kind,
      created_at: createdAt,
      tags,
      content: canonicalCompanyJson(record),
    },
    secret,
  );
}

function partyHead(overrides = {}, options = {}) {
  const record = { ...PARTY, ...overrides };
  const tags = [
    ["d", record.id],
    ["party-kind", record.kind],
    ...record.identifiers.map((identifier) => [
      "identifier",
      `${identifier.scheme}:${identifier.value}`,
    ]),
  ];
  return head(30182, record, tags, options.secret, options.createdAt);
}

function aliasHead(id, resolvesTo, options = {}) {
  const record = {
    schema: "colony.party-alias/v1",
    id,
    resolvesTo,
    mergedAt: 1_785_369_600,
    mergeActionEventId: "a".repeat(64),
  };
  return head(
    30182,
    record,
    [
      ["d", record.id],
      ["alias", record.resolvesTo],
    ],
    options.secret,
    options.createdAt,
  );
}

function relationshipHead(overrides = {}, options = {}) {
  const record = { ...LEAD, ...overrides };
  return head(
    30183,
    record,
    [
      ["d", record.id],
      ["party", record.partyId],
    ],
    options.secret,
    options.createdAt,
  );
}

/**
 * Apply the parts of a filter a relay would apply.
 *
 * Tests hand back whole fixture sets; the repository now issues targeted reads,
 * so a fake that ignored `kinds` and `#d` would hand a coordinate read every
 * head in the fixture and prove nothing about which one was asked for.
 */
function relayLike(fetchEvents) {
  return async (filter) => {
    const events = await fetchEvents(filter);
    return events.filter((event) => {
      if (filter.kinds?.length && !filter.kinds.includes(event.kind)) {
        return false;
      }
      const wanted = filter["#d"];
      if (!wanted?.length) return true;
      const dTag = event.tags.find((tag) => tag[0] === "d" && tag.length === 2);
      return dTag !== undefined && wanted.includes(dTag[1]);
    });
  };
}

function repository(fetchEvents) {
  resetPartyRepositoryState();
  return createPartyRepository({
    fetchEvents: relayLike(fetchEvents),
    relaySelf: async () => RELAY_PUBKEY,
  });
}

test("a relay-authored party head parses into its exact record", () => {
  const parsed = parsePartyHead(partyHead(), RELAY_PUBKEY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.type, "party");
  assert.deepEqual(parsed.value.party, PARTY);
});

test("an alias head at the same kind parses as a retired handle, not a party", () => {
  const parsed = parsePartyHead(
    aliasHead("acme-old", "acme-industries"),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.type, "alias");
  assert.equal(parsed.value.alias.resolvesTo, "acme-industries");
});

// The whole point of relay-authored heads is that nobody else can mint one. A
// parser that accepted a forgery would let any member who can publish an event
// invent a customer, or repoint an existing handle at one they control.
test("a party head signed by anyone other than the tenant relay is refused", () => {
  const parsed = parsePartyHead(
    partyHead({}, { secret: IMPOSTOR_SECRET }),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "wrong-author");
});

test("a tampered party head fails signature verification", () => {
  const event = partyHead();
  const tampered = {
    ...event,
    content: canonicalCompanyJson({ ...PARTY, displayName: "Someone Else" }),
  };
  const parsed = parsePartyHead(tampered, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-event");
});

// Identifier tags are how Discovery finds an existing party without scanning.
// A head tagged with a claim it does not hold is findable under an identifier
// that belongs to somebody else.
test("identifier tags must match the claims in the record", () => {
  const record = { ...PARTY };
  const event = head(30182, record, [
    ["d", record.id],
    ["party-kind", record.kind],
    ["identifier", "domain:not-acme.example"],
  ]);
  const parsed = parsePartyHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-head");
});

test("a relationship head parses into its exact record", () => {
  const parsed = parsePartyRelationshipHead(relationshipHead(), RELAY_PUBKEY);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, LEAD);
});

// The coordinate is what makes a second Lead on one party impossible. An id
// that does not derive from the party and the view would let one exist.
test("a relationship id that is not derived from its coordinate is refused", () => {
  const record = { ...LEAD, id: "acme-industries:prospect" };
  const event = head(30183, record, [
    ["d", record.id],
    ["party", record.partyId],
  ]);
  const parsed = parsePartyRelationshipHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-record");
});

test("a client status on a lead view is refused", () => {
  const parsed = parsePartyRelationshipHead(
    relationshipHead({ status: "active" }),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-record");
});

test("every read query names its kinds and scopes to the tenant relay", async () => {
  const filters = [];
  const repo = repository(async (filter) => {
    filters.push(filter);
    return filter.kinds[0] === 30182 ? [partyHead()] : [relationshipHead()];
  });

  await repo.listParties();
  await repo.listRelationships("acme-industries");

  assert.equal(filters.length, 2);
  for (const filter of filters) {
    assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0);
    assert.deepEqual(filter.authors, [RELAY_PUBKEY]);
  }
  // No company narrow: the relay answers for one community.
  assert.equal(filters[0]["#c"], undefined);
  assert.deepEqual(filters[1]["#d"], [
    "acme-industries:lead",
    "acme-industries:client",
  ]);
});

// Retired handles are not parties. A caller that treated one as a party would
// write new evidence to a coordinate that now only redirects.
test("listing keeps retired handles out of the party list", async () => {
  const repo = repository(async () => [
    partyHead(),
    aliasHead("acme-old", "acme-industries"),
  ]);
  const result = await repo.listParties();
  assert.equal(result.ok, true);
  assert.equal(result.value.parties.length, 1);
  assert.equal(result.value.parties[0].id, "acme-industries");
  assert.equal(result.value.retiredHandles.length, 1);
  assert.equal(result.value.retiredHandles[0].id, "acme-old");
});

// This is the promise the whole design rests on: a handle written into a task
// or an agent's work context months ago still has to arrive.
test("a retired handle resolves to the party that absorbed it", async () => {
  const repo = repository(async () => [
    partyHead(),
    aliasHead("acme-old", "acme-industries"),
  ]);
  const result = await repo.resolveHandle("acme-old");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    handle: "acme-industries",
    mergesFollowed: 1,
  });
});

// The reason a company can hold any number of parties: following a handle
// reads one coordinate per hop, so it never depends on how many exist.
test("resolving a handle reads one coordinate per hop, not the party set", async () => {
  const filters = [];
  const repo = repository(async (filter) => {
    filters.push(filter);
    return [
      partyHead(),
      aliasHead("acme-oldest", "acme-old"),
      aliasHead("acme-old", "acme-industries"),
      // Parties this walk must never read. An unscoped implementation would
      // pull them back on every hop.
      partyHead({ id: "bystander-one" }),
      partyHead({ id: "bystander-two" }),
    ];
  });

  const result = await repo.resolveHandle("acme-oldest");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    handle: "acme-industries",
    mergesFollowed: 2,
  });

  assert.equal(filters.length, 3, "two merges cost three reads");
  assert.deepEqual(
    filters.map((filter) => filter["#d"]),
    [["acme-oldest"], ["acme-old"], ["acme-industries"]],
    "each read names the one coordinate it wants",
  );
});

test("a live handle resolves to itself having followed nothing", async () => {
  const repo = repository(async () => [partyHead()]);
  const result = await repo.resolveHandle("acme-industries");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    handle: "acme-industries",
    mergesFollowed: 0,
  });
});

test("merges chain and the oldest handle still arrives", async () => {
  const repo = repository(async () => [
    partyHead(),
    aliasHead("acme-oldest", "acme-old"),
    aliasHead("acme-old", "acme-industries"),
  ]);
  const result = await repo.resolveHandle("acme-oldest");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    handle: "acme-industries",
    mergesFollowed: 2,
  });
});

// Validation refuses cycles, but a reader that meets one anyway must stop
// rather than loop the app.
test("a cycle is reported rather than followed", async () => {
  const repo = repository(async () => [
    aliasHead("acme-a", "acme-b"),
    aliasHead("acme-b", "acme-a"),
  ]);
  const result = await repo.resolveHandle("acme-a");
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-record");
  assert.match(result.message, /loops back/);
});

test("a chain longer than the cap is refused rather than chased", async () => {
  const links = [];
  for (let index = 0; index <= MAX_ALIAS_HOPS + 1; index += 1) {
    links.push(aliasHead(`link-${index}`, `link-${index + 1}`));
  }
  const repo = repository(async () => links);
  const result = await repo.resolveHandle("link-0");
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-record");
});

test("an unknown handle is missing, not broken", async () => {
  const repo = repository(async () => [partyHead()]);
  const result = await repo.resolveHandle("nobody");
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-head");
});

// Sales owns the pipeline and Accounts owns the engagement. One identity
// carries both, and neither decides anything for the other.
test("one party carries a lead and a client view at once", async () => {
  const repo = repository(async (filter) =>
    filter.kinds[0] === 30182
      ? [partyHead()]
      : [
          relationshipHead(),
          relationshipHead({
            id: "acme-industries:client",
            relationship: "client",
            status: "active",
            ownerPersonaId: "company-role:abc:horizonlabs:account-lead",
          }),
        ],
  );
  const result = await repo.getPartyWithViews("acme-industries");
  assert.equal(result.ok, true);
  assert.equal(result.value.relationships.length, 2);
  const lead = result.value.relationships.find(
    (view) => view.relationship === "lead",
  );
  const client = result.value.relationships.find(
    (view) => view.relationship === "client",
  );
  assert.equal(lead.status, "qualified");
  assert.equal(client.status, "active");
  assert.notEqual(lead.ownerPersonaId, client.ownerPersonaId);
});

test("reading a party through a retired handle reports the merge it followed", async () => {
  const repo = repository(async (filter) =>
    filter.kinds[0] === 30182
      ? [partyHead(), aliasHead("acme-old", "acme-industries")]
      : [relationshipHead()],
  );
  const result = await repo.getPartyWithViews("acme-old");
  assert.equal(result.ok, true);
  assert.equal(result.value.requested, "acme-old");
  assert.equal(result.value.handle, "acme-industries");
  assert.equal(result.value.mergesFollowed, 1);
  assert.equal(result.value.party.id, "acme-industries");
});

test("the newest head per coordinate wins", async () => {
  const repo = repository(async () => [
    partyHead({ displayName: "Acme" }, { createdAt: 1_785_369_700 }),
    partyHead(
      { displayName: "Acme Industries Ltd" },
      { createdAt: 1_785_369_800 },
    ),
  ]);
  const result = await repo.listParties();
  assert.equal(result.ok, true);
  assert.equal(result.value.parties.length, 1);
  assert.equal(result.value.parties[0].displayName, "Acme Industries Ltd");
});

// A read that started before a community switch resolves after it. Delivering
// its result would put the previous company's customers in front of the next.
test("a read in flight across a community switch is cancelled, not delivered", async () => {
  const repo = repository(async () => {
    resetPartyRepositoryState();
    return [partyHead()];
  });
  const result = await repo.listParties();
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
});

// `#c` is the indexed tag the relay can answer; it is not a guarantee. A head
// carrying another company's id must not reach the caller.
test("a party from another company is dropped even if the relay returns it", async () => {
  const repo = repository(async () => [
    partyHead(),
    partyHead({ id: "other-corp", companyId: "someone-else" }),
  ]);
  const result = await repo.listParties();
  assert.equal(result.ok, true);
  assert.equal(result.value.parties.length, 1);
  assert.equal(result.value.parties[0].id, "acme-industries");
});

test("relationship coordinates are derived, not chosen", () => {
  assert.equal(
    relationshipCoordinate("acme-industries", "lead"),
    "acme-industries:lead",
  );
  assert.equal(
    relationshipCoordinate("acme-industries", "client"),
    "acme-industries:client",
  );
});
