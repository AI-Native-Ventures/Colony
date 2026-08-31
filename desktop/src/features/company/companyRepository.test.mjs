import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  canonicalCompanyJson,
  newestHead,
  parseCompanyHead,
  parseInitiativeHead,
  parseTaskHead,
} from "./contracts.ts";
import {
  createCompanyRepository,
  resetCompanyRepositoryState,
} from "./companyRepository.ts";
import { createCompanyActionBroker } from "./workRepository.ts";

const RELAY_SECRET = generateSecretKey();
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const IMPOSTOR_SECRET = generateSecretKey();

const COMPANY = {
  schema: "colony.company/v1",
  tradingName: "Horizon Labs",
  legalName: null,
  website: "https://horizonlabs.co.za",
  summary: "Builds software for South African businesses.",
  businessType: "agency",
  services: [
    { id: "web", name: "Web builds", description: "Sites and web apps." },
  ],
  customerSegments: ["small business"],
  costCentres: [
    { id: "cc-web", name: "Web builds", kind: "service", serviceId: "web" },
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

const INITIATIVE = {
  schema: "colony.initiative/v1",
  id: "horizonlabs:launch-outbound",
  title: "Launch outbound",
  summary: "Open a first outbound channel to small businesses.",
  status: "proposed",
  ownerPersonaId: "relay1:horizonlabs:chief-of-staff",
  costCentreId: "cc-internal",
  commercialPurpose: "sales",
  clientOrganizationId: null,
  expectedCostUsd: null,
  sourceChannelId: "welcome",
  sourceEventId: null,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_000,
};

const TASK = {
  schema: "colony.task/v1",
  id: "horizonlabs:launch-outbound:draft-list",
  initiativeId: "horizonlabs:launch-outbound",
  title: "Draft the first prospect list",
  status: "ready",
  owningTeamId: "relay1:horizonlabs:sales",
  assigneePersonaIds: ["relay1:horizonlabs:sales-lead"],
  qaPersonaId: "relay1:horizonlabs:sales-lead",
  reviewerTeamId: null,
  costCentreId: "cc-internal",
  commercialPurpose: "sales",
  clientOrganizationId: null,
  sourceChannelId: "welcome",
  sourceEventId: null,
  implicit: false,
  dependsOn: ["horizonlabs:launch-outbound:build-site"],
  subject: { kind: "party", ref: "acme-lead" },
  stage: "draft-list",
  threadRoot:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  doerKind: "human",
  wakeAt: null,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_000,
};

/** The six chain-and-identity fields serde defaults when absent, which is
 * exactly what heads written before Phase 1a lack. */
const CHAIN_FIELDS = [
  "dependsOn",
  "subject",
  "stage",
  "threadRoot",
  "doerKind",
  "wakeAt",
];
const CHAIN_FIELD_DEFAULTS = {
  dependsOn: [],
  subject: null,
  stage: null,
  threadRoot: null,
  doerKind: "agent",
  wakeAt: null,
};

/** Build the exact head the relay broker signs, so the parser is tested
 * against the shape it will actually meet rather than a convenient one. */
function head(
  kind,
  record,
  tags,
  secret = RELAY_SECRET,
  createdAt = 1_780_000_100,
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

function companyHead(overrides = {}, options = {}) {
  const record = { ...COMPANY, ...overrides };
  return head(
    30179,
    record,
    [["d", "profile"]],
    options.secret,
    options.createdAt,
  );
}

function initiativeHead(overrides = {}, options = {}) {
  const record = { ...INITIATIVE, ...overrides };
  return head(
    30180,
    record,
    [
      ["d", record.id],
      ["cost-centre", record.costCentreId],
    ],
    options.secret,
    options.createdAt,
  );
}

/** The exact tags company_broker's build_head derives from validated
 * content, mirrors included, so queries are tested against heads that look
 * like what a real relay signs rather than a convenient subset. */
function taskHead(overrides = {}, options = {}) {
  const record = { ...TASK, ...overrides };
  const tags = [
    ["d", record.id],
    ["team", record.owningTeamId],
    ["g", record.owningTeamId],
    ["cost-centre", record.costCentreId],
    ["w", record.status],
  ];
  for (const dependency of record.dependsOn) tags.push(["v", dependency]);
  if (record.initiativeId) {
    tags.push(["initiative", record.initiativeId]);
    tags.push(["i", record.initiativeId]);
  }
  if (record.stage) tags.push(["s", record.stage]);
  if (record.subject) {
    tags.push(["u", `${record.subject.kind}:${record.subject.ref}`]);
  }
  return head(30181, record, tags, options.secret, options.createdAt);
}

test("a relay-authored company head parses into its exact record", () => {
  const parsed = parseCompanyHead(companyHead(), RELAY_PUBKEY);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, COMPANY);
});

test("initiative and task heads parse into their exact records", () => {
  const initiative = parseInitiativeHead(initiativeHead(), RELAY_PUBKEY);
  assert.equal(initiative.ok, true);
  assert.deepEqual(initiative.value, INITIATIVE);

  const task = parseTaskHead(taskHead(), RELAY_PUBKEY);
  assert.equal(task.ok, true);
  // The subject key is literally `ref` because the Rust field is the raw
  // identifier `r#ref`; deepEqual proves the JSON spelling survived.
  assert.deepEqual(task.value, TASK);
  assert.equal("ref" in task.value.subject, true);
});

/** Heads written before the chain-and-identity fields existed are still on
 * real relays and still deserialize in Rust to the serde defaults. Desktop
 * must accept them too: refusing them would blank every existing community's
 * task board on upgrade. The injected defaults mirror Rust field for field,
 * while unknown keys stay rejected — only these six may be absent. */
test("a task head written before the chain fields existed still parses", () => {
  const record = { ...TASK };
  for (const name of CHAIN_FIELDS) delete record[name];
  // Built raw rather than through taskHead(): that helper merges onto the
  // full TASK fixture, which would quietly hand the six fields back.
  const event = finalizeEvent(
    {
      kind: 30181,
      created_at: 1_780_000_100,
      tags: [
        ["d", record.id],
        ["team", record.owningTeamId],
        ["cost-centre", record.costCentreId],
        ["initiative", record.initiativeId],
      ],
      content: canonicalCompanyJson(record),
    },
    RELAY_SECRET,
  );
  const parsed = parseTaskHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { ...TASK, ...CHAIN_FIELD_DEFAULTS });
});

/** The relay OMITS `reviewerTeamId` rather than nulling it, so an absent key
 * is the ordinary case for this field, not only a legacy one. Desktop builds
 * shipped before it existed match on an exact field set, so writing it as
 * null would have made every task head unparseable on all of them. */
test("a task head omitting reviewerTeamId parses with a null reviewer", () => {
  const record = { ...TASK };
  delete record.reviewerTeamId;
  const event = finalizeEvent(
    {
      kind: 30181,
      created_at: 1_780_000_100,
      tags: [
        ["d", record.id],
        ["team", record.owningTeamId],
        ["cost-centre", record.costCentreId],
        ["initiative", record.initiativeId],
      ],
      content: canonicalCompanyJson(record),
    },
    RELAY_SECRET,
  );
  const parsed = parseTaskHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.reviewerTeamId, null);
});

test("a task head naming a reviewer team keeps it", () => {
  const parsed = parseTaskHead(
    taskHead({ ...TASK, reviewerTeamId: "relay1:horizonlabs:qa" }),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.reviewerTeamId, "relay1:horizonlabs:qa");
});

test("an explicit null or wrong-typed chain field is still refused", () => {
  // An explicit `doerKind: null` in content fails in Rust (not an Option) and
  // must fail here: the injection only covers ABSENT keys.
  const nulled = parseTaskHead(
    taskHead({ ...TASK, doerKind: null }),
    RELAY_PUBKEY,
  );
  assert.equal(nulled.ok, false);
  assert.equal(nulled.code, "invalid-record");

  const badDoer = parseTaskHead(
    taskHead({ ...TASK, doerKind: "robot" }),
    RELAY_PUBKEY,
  );
  assert.equal(badDoer.ok, false);

  // wakeAt is i64: a fractional timestamp is not an integer.
  const fractional = parseTaskHead(
    taskHead({ ...TASK, wakeAt: 1_800_000_000.5 }),
    RELAY_PUBKEY,
  );
  assert.equal(fractional.ok, false);

  const incompleteSubject = parseTaskHead(
    taskHead({ ...TASK, subject: { kind: "party" } }),
    RELAY_PUBKEY,
  );
  assert.equal(incompleteSubject.ok, false);
});

test("snoozed is a valid task status", () => {
  const parsed = parseTaskHead(
    taskHead({ ...TASK, status: "snoozed", wakeAt: 1_800_000_000 }),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.status, "snoozed");
});

// The whole point of relay-authored heads is that nobody else can mint one. A
// parser that accepted a well-formed forgery would hand the app a company
// record written by any member who can publish an event.
test("a head signed by anyone other than the tenant relay is refused", () => {
  const forged = companyHead({}, { secret: IMPOSTOR_SECRET });
  const parsed = parseCompanyHead(forged, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "wrong-author");
});

test("a tampered head fails signature verification", () => {
  const event = companyHead();
  const tampered = {
    ...event,
    content: canonicalCompanyJson({ ...COMPANY, tradingName: "Someone Else" }),
  };
  const parsed = parseCompanyHead(tampered, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-event");
});

test("the d tag must match the record id exactly", () => {
  const event = finalizeEvent(
    {
      kind: 30179,
      created_at: 1_780_000_100,
      tags: [["d", "someone-else"]],
      content: canonicalCompanyJson(COMPANY),
    },
    RELAY_SECRET,
  );
  const parsed = parseCompanyHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-head");
});

test("a task head's team and initiative tags must match its content", () => {
  const record = { ...TASK };
  const event = finalizeEvent(
    {
      kind: 30181,
      created_at: 1_780_000_100,
      tags: [
        ["d", record.id],
        ["team", "some-other-team"],
        ["cost-centre", record.costCentreId],
        ["initiative", record.initiativeId],
      ],
      content: canonicalCompanyJson(record),
    },
    RELAY_SECRET,
  );
  const parsed = parseTaskHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-head");
});

test("wrong kinds never parse as company records", () => {
  const asInitiative = parseInitiativeHead(companyHead(), RELAY_PUBKEY);
  assert.equal(asInitiative.ok, false);
  assert.equal(asInitiative.code, "invalid-event");
});

// Rust rejects unknown fields on every one of these records. A looser parser
// here means the two implementations disagree about what is valid, and the
// disagreement only shows up on real input.
test("unknown and missing fields are both refused", () => {
  const extra = companyHead({ favouriteColour: "violet" });
  const parsedExtra = parseCompanyHead(extra, RELAY_PUBKEY);
  assert.equal(parsedExtra.ok, false);
  assert.equal(parsedExtra.code, "invalid-record");

  const missing = { ...COMPANY };
  delete missing.businessType;
  const parsedMissing = parseCompanyHead(
    head(30179, missing, [["d", "profile"]]),
    RELAY_PUBKEY,
  );
  assert.equal(parsedMissing.ok, false);
  assert.equal(parsedMissing.code, "invalid-record");
});

test("statuses outside the contract are refused", () => {
  const parsed = parseInitiativeHead(
    initiativeHead({ status: "shipped" }),
    RELAY_PUBKEY,
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-record");
});

test("non-canonical content is refused", () => {
  const event = finalizeEvent(
    {
      kind: 30179,
      created_at: 1_780_000_100,
      tags: [["d", "profile"]],
      content: JSON.stringify(COMPANY),
    },
    RELAY_SECRET,
  );
  const parsed = parseCompanyHead(event, RELAY_PUBKEY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "invalid-record");
});

test("the newest head wins, and an id break settles a tie", () => {
  const older = initiativeHead(
    { status: "proposed" },
    { createdAt: 1_780_000_100 },
  );
  const newer = initiativeHead(
    { status: "approved" },
    { createdAt: 1_780_000_200 },
  );
  const chosen = newestHead([newer, older]);
  assert.equal(chosen?.id, newer.id);
  assert.equal(newestHead([older, newer])?.id, newer.id);

  // NIP-01 settles a same-timestamp replaceable tie on the lowest event id.
  const a = initiativeHead(
    { summary: "First wording." },
    { createdAt: 1_780_000_300 },
  );
  const b = initiativeHead(
    { summary: "Second wording." },
    { createdAt: 1_780_000_300 },
  );
  const expected = a.id < b.id ? a.id : b.id;
  assert.equal(newestHead([a, b])?.id, expected);
  assert.equal(newestHead([b, a])?.id, expected);
  assert.equal(newestHead([]), null);
});

test("every read query names its kinds and scopes to the tenant relay", async () => {
  resetCompanyRepositoryState();
  const filters = [];
  const repository = createCompanyRepository({
    fetchEvents: async (filter) => {
      filters.push(filter);
      if (filter.kinds[0] === 30179) return [companyHead()];
      if (filter.kinds[0] === 30180) return [initiativeHead()];
      return [taskHead()];
    },
    relaySelf: async () => RELAY_PUBKEY,
  });

  await repository.getActiveCompany();
  await repository.listInitiatives();
  await repository.listTasks({ initiativeId: "horizonlabs:launch-outbound" });

  assert.equal(filters.length, 3);
  for (const filter of filters) {
    assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0);
    assert.deepEqual(filter.authors, [RELAY_PUBKEY]);
  }
  // The profile sits at one fixed coordinate; initiatives need no narrow at
  // all, because the relay only ever answers for one community.
  assert.deepEqual(filters[0]["#d"], ["profile"]);
  assert.equal(filters[1]["#c"], undefined);
  // Single-letter mirror only. `#initiative` is dropped by the nostr filter
  // type before it reaches a relay, so querying it would silently match
  // nothing useful.
  assert.deepEqual(filters[2]["#i"], ["horizonlabs:launch-outbound"]);
});

test("work-surface narrows compile to single-letter tag filters", async () => {
  resetCompanyRepositoryState();
  const filters = [];
  const repository = createCompanyRepository({
    fetchEvents: async (filter) => {
      filters.push(filter);
      return [];
    },
    relaySelf: async () => RELAY_PUBKEY,
  });

  await repository.listTasks({
    initiativeId: "horizonlabs:launch-outbound",
    status: "inProgress",
    teamId: "relay1:horizonlabs:sales",
    stage: "outreach-pack",
    subject: { kind: "party", ref: "acme-lead" },
  });

  assert.equal(filters.length, 1);
  const filter = filters[0];
  assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0);
  assert.deepEqual(filter.authors, [RELAY_PUBKEY]);
  assert.equal(filter["#c"], undefined);
  assert.deepEqual(filter["#i"], ["horizonlabs:launch-outbound"]);
  assert.deepEqual(filter["#w"], ["inProgress"]);
  assert.deepEqual(filter["#g"], ["relay1:horizonlabs:sales"]);
  assert.deepEqual(filter["#s"], ["outreach-pack"]);
  // Spelled exactly as build_head mirrors the subject.
  assert.deepEqual(filter["#u"], ["party:acme-lead"]);
});

// The relay ANDs tag names, but a head that slipped past the wire filter (an
// older relay, a race with a replacement) must not surface as a wrong result:
// results are re-checked against signed content.
test("results are narrowed again against content after parsing", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [
      taskHead(),
      taskHead({
        id: "horizonlabs:launch-outbound:blocked-row",
        title: "Blocked sibling",
        status: "blocked",
        updatedAt: 1_780_000_300,
      }),
    ],
    relaySelf: async () => RELAY_PUBKEY,
  });
  const result = await repository.listTasks({
    status: "blocked",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.map((task) => task.id),
    ["horizonlabs:launch-outbound:blocked-row"],
  );
});

test("a thread's tasks come back live-first, newest within each band", async () => {
  resetCompanyRepositoryState();
  const THREAD =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const OTHER_THREAD = "f".repeat(64);
  const repository = createCompanyRepository({
    fetchEvents: async () => [
      // Terminal, oldest update — belongs last.
      taskHead({
        id: "horizonlabs:t:build",
        status: "completed",
        threadRoot: THREAD,
        updatedAt: 1_780_001_000,
      }),
      // Live but older than the snoozed one below.
      taskHead({
        id: "horizonlabs:t:pack",
        status: "inProgress",
        threadRoot: THREAD,
        updatedAt: 1_780_002_000,
      }),
      taskHead({
        id: "horizonlabs:t:run",
        status: "snoozed",
        wakeAt: 1_800_000_000,
        threadRoot: THREAD,
        updatedAt: 1_780_003_000,
      }),
      // Same company, different thread.
      taskHead({
        id: "horizonlabs:t:elsewhere",
        status: "inProgress",
        threadRoot: OTHER_THREAD,
        updatedAt: 1_780_004_000,
      }),
      // Chat-spawned tasks can have no thread at all.
      taskHead({ id: "horizonlabs:t:orphan", threadRoot: null }),
    ],
    relaySelf: async () => RELAY_PUBKEY,
  });

  const result = await repository.listThreadTasks({
    threadRoot: THREAD.toUpperCase(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.map((task) => [task.id, task.status]),
    [
      ["horizonlabs:t:run", "snoozed"],
      ["horizonlabs:t:pack", "inProgress"],
      ["horizonlabs:t:build", "completed"],
    ],
  );
});

test("listing a thread's tasks pins kinds, author, and the company index", async () => {
  resetCompanyRepositoryState();
  const filters = [];
  const repository = createCompanyRepository({
    fetchEvents: async (filter) => {
      filters.push(filter);
      return [];
    },
    relaySelf: async () => RELAY_PUBKEY,
  });
  await repository.listThreadTasks({
    threadRoot: "a".repeat(64),
  });
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].kinds, [30181]);
  assert.deepEqual(filters[0].authors, [RELAY_PUBKEY]);
  assert.equal(filters[0]["#c"], undefined);
});

test("thread and list queries refuse to run without their required input", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [],
    relaySelf: async () => RELAY_PUBKEY,
  });

  const noThread = await repository.listThreadTasks({
    threadRoot: "   ",
  });
  assert.equal(noThread.ok, false);
  assert.equal(noThread.code, "invalid-record");

  // An unnarrowed list is legal now: the community is the scope, so
  // "every task" is already bounded.
  const noScope = await repository.listTasks({ status: "ready" });
  assert.equal(noScope.ok, true);
});

test("listing initiatives keeps only the newest head per coordinate", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [
      initiativeHead({ status: "proposed" }, { createdAt: 1_780_000_100 }),
      initiativeHead({ status: "approved" }, { createdAt: 1_780_000_200 }),
      initiativeHead(
        { id: "horizonlabs:hire", title: "Hire a second engineer" },
        { createdAt: 1_780_000_150 },
      ),
    ],
    relaySelf: async () => RELAY_PUBKEY,
  });

  const result = await repository.listInitiatives();
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 2);
  const outbound = result.value.find(
    (initiative) => initiative.id === "horizonlabs:launch-outbound",
  );
  assert.equal(outbound.status, "approved");
});

// A forged head sitting next to real ones must not take the whole list down
// with it, and must not appear in it either.
test("an unparseable head is dropped without failing the list", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [
      initiativeHead(),
      initiativeHead({ id: "horizonlabs:forged" }, { secret: IMPOSTOR_SECRET }),
    ],
    relaySelf: async () => RELAY_PUBKEY,
  });
  const result = await repository.listInitiatives();
  assert.equal(result.ok, true);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].id, "horizonlabs:launch-outbound");
});

test("empty results are an empty list, not a failure", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [],
    relaySelf: async () => RELAY_PUBKEY,
  });
  const initiatives = await repository.listInitiatives();
  assert.equal(initiatives.ok, true);
  assert.deepEqual(initiatives.value, []);

  const company = await repository.getActiveCompany();
  assert.equal(company.ok, false);
  assert.equal(company.code, "missing-head");
});

test("a relay failure is reported, never treated as absence", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      throw new Error("socket is not connected");
    },
    relaySelf: async () => RELAY_PUBKEY,
  });
  const result = await repository.listInitiatives();
  assert.equal(result.ok, false);
  assert.equal(result.code, "unavailable");
});

test("a community without a relay identity cannot be read from", async () => {
  resetCompanyRepositoryState();
  const repository = createCompanyRepository({
    fetchEvents: async () => [companyHead()],
    relaySelf: async () => null,
  });
  const result = await repository.getActiveCompany();
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-relay-identity");
});

// Switching community remounts React but leaves module state alone. A read
// that started before the switch must not resolve into the new community.
test("a read in flight across a community switch is cancelled", async () => {
  resetCompanyRepositoryState();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      await gate;
      return [companyHead()];
    },
    relaySelf: async () => RELAY_PUBKEY,
  });

  const pending = repository.getActiveCompany();
  resetCompanyRepositoryState();
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
});

const RECEIPT_TAGS = (actionEventId, outcome, requestId, idempotencyKey) => [
  ["p", "f".repeat(64)],
  ["e", actionEventId, "", "company-action"],
  ["a", `30180:${RELAY_PUBKEY}:horizonlabs:launch-outbound`],
  ["company-receipt", "1", requestId, idempotencyKey, outcome],
];

const REQUEST_ID = "6f1d2b3c-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "6f1d2b3c-0000-4000-8000-000000000002";

function receipt(actionEventId, outcome, headEventId) {
  return finalizeEvent(
    {
      kind: 40014,
      created_at: 1_780_000_200,
      tags: RECEIPT_TAGS(actionEventId, outcome, REQUEST_ID, IDEMPOTENCY_KEY),
      content: canonicalCompanyJson({
        schema: "colony.company-receipt/v1",
        headEventId: headEventId ?? null,
      }),
    },
    RELAY_SECRET,
  );
}

function signedAction() {
  return finalizeEvent(
    {
      kind: 40013,
      created_at: 1_780_000_150,
      tags: [
        ["p", RELAY_PUBKEY],
        ["a", `30180:${RELAY_PUBKEY}:horizonlabs:launch-outbound`],
        ["company-action", "1", "transition", REQUEST_ID, IDEMPOTENCY_KEY],
      ],
      content: "{}",
    },
    IMPOSTOR_SECRET,
  );
}

test("an applied receipt resolves the head the relay authored", async () => {
  const action = signedAction();
  const applied = receipt(action.id, "applied", initiativeHead().id);
  const broker = createCompanyActionBroker({
    publish: async (event) => event,
    fetchFirstEvent: async (filter) => {
      if (filter.kinds[0] === 40014) return applied;
      return initiativeHead({ status: "approved" });
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
  });

  const outcome = await broker.submit(JSON.stringify(action));
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.receiptEventId, applied.id);
  assert.equal(outcome.headEventId, initiativeHead().id);
});

test("a conflict receipt is surfaced as a conflict, not a success", async () => {
  const action = signedAction();
  const conflict = receipt(action.id, "conflict", null);
  const broker = createCompanyActionBroker({
    publish: async (event) => event,
    fetchFirstEvent: async () => conflict,
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
  });
  const outcome = await broker.submit(JSON.stringify(action));
  assert.equal(outcome.status, "conflict");
});

// A receipt is only meaningful because the relay signed it. Accepting one
// signed by anyone else would let a member fake a successful company write.
test("a receipt not signed by the tenant relay is ignored", async () => {
  const action = signedAction();
  const forged = finalizeEvent(
    {
      kind: 40014,
      created_at: 1_780_000_200,
      tags: RECEIPT_TAGS(action.id, "applied", REQUEST_ID, IDEMPOTENCY_KEY),
      content: canonicalCompanyJson({
        schema: "colony.company-receipt/v1",
        headEventId: initiativeHead().id,
      }),
    },
    IMPOSTOR_SECRET,
  );
  const broker = createCompanyActionBroker({
    publish: async (event) => event,
    fetchFirstEvent: async () => forged,
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
    attempts: 2,
  });
  const outcome = await broker.submit(JSON.stringify(action));
  assert.equal(outcome.status, "no-receipt");
});

test("a receipt that never arrives is reported as unresolved, not as failure", async () => {
  const action = signedAction();
  let polls = 0;
  const broker = createCompanyActionBroker({
    publish: async (event) => event,
    fetchFirstEvent: async () => {
      polls += 1;
      return null;
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
    attempts: 3,
  });
  const outcome = await broker.submit(JSON.stringify(action));
  assert.equal(outcome.status, "no-receipt");
  assert.equal(polls, 3);
});

test("only a company action can be submitted through the broker", async () => {
  const broker = createCompanyActionBroker({
    publish: async (event) => event,
    fetchFirstEvent: async () => null,
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
  });
  await assert.rejects(
    () => broker.submit(JSON.stringify(initiativeHead())),
    /company action/i,
  );
});

// Company records are commercial state. Caching them in localStorage would
// leave one community's task titles readable after switching to another.
test("no company record is written to local storage", async () => {
  resetCompanyRepositoryState();
  const writes = [];
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: (key, value) => writes.push([key, value]),
    removeItem: () => {},
  };
  try {
    const repository = createCompanyRepository({
      fetchEvents: async () => [taskHead()],
      relaySelf: async () => RELAY_PUBKEY,
    });
    await repository.listTasks({ companyId: "horizonlabs" });
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
  assert.deepEqual(writes, []);
});

// The ordinary lookup (a task board render, a thread reference someone
// clicked) has no write it just made to wait out: a miss means the Task
// genuinely does not exist here, so it must fail on the first try. Retrying
// it would just make every non-existent task take a second longer to report.
test("the ordinary task read stays single-shot even if retry options are supplied", async () => {
  resetCompanyRepositoryState();
  let calls = 0;
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      calls += 1;
      return [];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {
      throw new Error("must not be reached");
    },
    taskReadBackAttempts: 5,
    taskReadBackIntervalMs: 10,
  });

  const result = await repository.getTask(TASK.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-head");
  assert.equal(calls, 1);
});

// The write this reads back already happened — the caller only gets here
// after an applied or conflicting receipt — so a miss on the first try is the
// read lagging the write, not the Task being absent. Refusing to send on that
// first miss is the bug: the send is safe to retry, but the retry rebuilds
// byte-identical bytes and lands on the same idempotency claim, which is a
// worse user experience than this read simply trying again.
test("a task read-back retries past index lag instead of failing on the first miss", async () => {
  resetCompanyRepositoryState();
  const head = taskHead();
  let calls = 0;
  const delays = [];
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      calls += 1;
      return calls < 3 ? [] : [head];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async (ms) => {
      delays.push(ms);
    },
    taskReadBackAttempts: 5,
    taskReadBackIntervalMs: 50,
  });

  const result = await repository.getTaskAfterAction(TASK.id);
  assert.equal(result.ok, true);
  assert.equal(result.value.id, TASK.id);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 50]);
});

test("a task read-back gives up after its bounded attempts", async () => {
  resetCompanyRepositoryState();
  let calls = 0;
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      calls += 1;
      return [];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
    taskReadBackAttempts: 3,
    taskReadBackIntervalMs: 10,
  });

  const result = await repository.getTaskAfterAction(TASK.id);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-head");
  assert.equal(calls, 3);
});

// An applied receipt names the exact event the relay just wrote. Reading it
// by id hits the event store directly rather than whatever the `#d` tag
// filter indexes, so it is tried first when the caller has one.
test("a task read-back with a head event id queries by id, not by coordinate", async () => {
  resetCompanyRepositoryState();
  const head = taskHead();
  const filters = [];
  const repository = createCompanyRepository({
    fetchEvents: async (filter) => {
      filters.push(filter);
      return [head];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
  });

  const result = await repository.getTaskAfterAction(TASK.id, head.id);
  assert.equal(result.ok, true);
  assert.equal(result.value.id, TASK.id);
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].ids, [head.id]);
  assert.equal(filters[0]["#d"], undefined);
});

// A head event id that has not shown up yet still recovers on retry, the
// same way the coordinate path does.
test("a task read-back by head event id also retries past index lag", async () => {
  resetCompanyRepositoryState();
  const head = taskHead();
  let calls = 0;
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      calls += 1;
      return calls < 2 ? [] : [head];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
    taskReadBackAttempts: 5,
    taskReadBackIntervalMs: 10,
  });

  const result = await repository.getTaskAfterAction(TASK.id, head.id);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

// A read cancelled by a community switch is not indexing lag — retrying it
// would only risk delivering the old community's Task into the new one.
test("a task read-back does not retry past a community switch", async () => {
  resetCompanyRepositoryState();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const repository = createCompanyRepository({
    fetchEvents: async () => {
      calls += 1;
      await gate;
      return [];
    },
    relaySelf: async () => RELAY_PUBKEY,
    delay: async () => {},
    taskReadBackAttempts: 5,
    taskReadBackIntervalMs: 10,
  });

  const pending = repository.getTaskAfterAction(TASK.id);
  resetCompanyRepositoryState();
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
  assert.equal(calls, 1);
});
