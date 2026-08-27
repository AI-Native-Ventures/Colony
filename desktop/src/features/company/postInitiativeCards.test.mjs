import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitiativeCardPoster,
  derivedInstanceId,
  initiativeCardData,
  postedInstanceIds,
} from "./postInitiativeCards.ts";

const RELAY = "b".repeat(64);
const MANIFEST_ID = "c".repeat(64);
const CHANNEL = "welcome";

const COMPANY = {
  schema: "colony.company/v1",
  id: "horizonlabs",
  tradingName: "Horizon Labs",
  legalName: null,
  website: null,
  summary: "Software for South African businesses.",
  businessType: "agency",
  services: [],
  customerSegments: [],
  costCentres: [
    {
      id: "cc-internal",
      name: "Company coordination",
      kind: "internal",
      serviceId: null,
    },
  ],
  sourceReportEventId: null,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_000,
};

function initiative(overrides = {}) {
  return {
    schema: "colony.initiative/v1",
    id: "horizonlabs:launch-outbound",
    title: "Launch outbound",
    summary: "Open a first outbound channel.",
    status: "proposed",
    ownerPersonaId: "company-role:abc:horizonlabs:sales-lead",
    costCentreId: "cc-internal",
    commercialPurpose: "sales",
    clientOrganizationId: null,
    expectedCostUsd: null,
    sourceChannelId: CHANNEL,
    sourceEventId: null,
    createdAt: 1_780_000_000,
    updatedAt: 1_780_000_000,
    ...overrides,
  };
}

function catalogEvent(manifestId = MANIFEST_ID, status = "active") {
  return {
    id: "d".repeat(64),
    pubkey: RELAY,
    created_at: 1_780_000_000,
    kind: 30178,
    tags: [["d", "initiative"]],
    content: JSON.stringify({
      active_manifest_id: manifestId,
      status,
    }),
    sig: "0".repeat(128),
  };
}

function poster({
  initiatives = [initiative()],
  channelEvents = [],
  catalog = catalogEvent(),
} = {}) {
  const published = [];
  const run = createInitiativeCardPoster({
    relaySelf: async () => RELAY,
    loadCompany: async () => ({ ok: true, value: COMPANY }),
    loadInitiatives: async () => ({ ok: true, value: initiatives }),
    fetchChannel: async () => channelEvents,
    fetchCatalog: async () => catalog,
    sign: async (input) => ({
      id: `e${published.length}`.padEnd(64, "0"),
      pubkey: "f".repeat(64),
      created_at: 1_780_000_500,
      kind: input.kind,
      tags: input.tags,
      content: input.content,
      sig: "0".repeat(128),
    }),
    publish: async (event) => {
      published.push(event);
      return event;
    },
  });
  return { run, published };
}

test("one card is posted per proposed initiative", async () => {
  const { run, published } = poster({
    initiatives: [
      initiative(),
      initiative({ id: "horizonlabs:hire", title: "Hire an engineer" }),
    ],
  });
  const result = await run({ companyId: "horizonlabs", channelId: CHANNEL });
  assert.deepEqual(result.posted, [
    "horizonlabs:launch-outbound",
    "horizonlabs:hire",
  ]);
  assert.equal(published.length, 2);

  const [card] = published;
  assert.equal(card.kind, 9);
  const blockTag = card.tags.find((tag) => tag[0] === "block");
  assert.deepEqual(blockTag, [
    "block",
    "1",
    "initiative",
    MANIFEST_ID,
    derivedInstanceId("horizonlabs:launch-outbound"),
  ]);
  assert.deepEqual(
    card.tags.find((tag) => tag[0] === "e"),
    ["e", MANIFEST_ID, "", "block"],
  );
  assert.deepEqual(
    card.tags.find((tag) => tag[0] === "h"),
    ["h", CHANNEL],
  );
});

// Approving twice is an explicitly supported retry. Papering the conversation
// with a second set of cards would make a safe retry look destructive.
test("a card already in the channel is not posted again", async () => {
  const existing = {
    id: "1".repeat(64),
    pubkey: "f".repeat(64),
    created_at: 1_780_000_400,
    kind: 9,
    tags: [
      ["h", CHANNEL],
      [
        "block",
        "1",
        "initiative",
        MANIFEST_ID,
        derivedInstanceId("horizonlabs:launch-outbound"),
      ],
    ],
    content: "Launch outbound",
    sig: "0".repeat(128),
  };
  const { run, published } = poster({ channelEvents: [existing] });
  const result = await run({ companyId: "horizonlabs", channelId: CHANNEL });
  assert.deepEqual(result.posted, []);
  assert.deepEqual(result.skipped, ["horizonlabs:launch-outbound"]);
  assert.equal(published.length, 0);
});

test("an initiative that is no longer proposed gets no card", async () => {
  const { run, published } = poster({
    initiatives: [initiative({ status: "active" })],
  });
  const result = await run({ companyId: "horizonlabs", channelId: CHANNEL });
  assert.deepEqual(result.posted, []);
  assert.equal(published.length, 0);
});

test("nothing is posted without an active manifest for the card", async () => {
  for (const [label, catalog] of [
    ["no catalog head", null],
    ["retired handle", catalogEvent(MANIFEST_ID, "retired")],
    ["unusable manifest id", catalogEvent("not-an-event-id")],
  ]) {
    const { run, published } = poster({ catalog });
    const result = await run({ companyId: "horizonlabs", channelId: CHANNEL });
    assert.deepEqual(result.posted, [], label);
    assert.equal(published.length, 0, label);
  }
});

test("the card names the initiative, its cost centre, and its purpose", () => {
  const data = initiativeCardData(initiative(), COMPANY);
  assert.deepEqual(data, {
    initiative_id: "horizonlabs:launch-outbound",
    title: "Launch outbound",
    summary: "Open a first outbound channel.",
    status: "proposed",
    owner: "Sales lead",
    cost_centre: "Company coordination",
    commercial_purpose: "sales",
  });
});

// The instance ID is what makes reposting safe. Deriving it means a retry on a
// different device, after a lost journal, still lands on the same identity.
test("the instance id is derived, stable, and unique per initiative", () => {
  const first = derivedInstanceId("horizonlabs:launch-outbound");
  assert.equal(first, derivedInstanceId("horizonlabs:launch-outbound"));
  assert.notEqual(first, derivedInstanceId("horizonlabs:hire"));
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("only initiative cards count as already posted", () => {
  const posted = postedInstanceIds([
    {
      tags: [
        [
          "block",
          "1",
          "interview",
          MANIFEST_ID,
          "11111111-1111-4111-8111-111111111111",
        ],
      ],
    },
    {
      tags: [
        [
          "block",
          "1",
          "initiative",
          MANIFEST_ID,
          "22222222-2222-4222-8222-222222222222",
        ],
      ],
    },
  ]);
  assert.deepEqual([...posted], ["22222222-2222-4222-8222-222222222222"]);
});
