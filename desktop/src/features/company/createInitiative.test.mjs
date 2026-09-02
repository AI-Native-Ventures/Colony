import assert from "node:assert/strict";
import { test } from "node:test";

import { createInitiativeCreator } from "./createInitiative.ts";

const RELAY = "a".repeat(64);
const CHANNEL_ID = "general";
const COST_CENTRE_ID = "cc-internal";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const INITIATIVE_ID = "user-initiative:0001";

function companyHeadEvent() {
  return {
    id: "c".repeat(64),
    pubkey: RELAY,
    created_at: 1_780_000_100,
    kind: 30179,
    tags: [["d", "profile"]],
    content: "{}",
    sig: "0".repeat(128),
  };
}

function initiative(overrides = {}) {
  return {
    schema: "colony.initiative/v1",
    id: INITIATIVE_ID,
    title: "Open a Cape Town desk",
    summary: "",
    status: "proposed",
    ownerPersonaId: "relay1:horizonlabs:chief-of-staff",
    costCentreId: COST_CENTRE_ID,
    commercialPurpose: "administration",
    clientOrganizationId: null,
    expectedCostUsd: null,
    sourceChannelId: CHANNEL_ID,
    sourceEventId: null,
    templateId: null,
    templateVersion: null,
    cohortId: null,
    createdAt: 1_780_000_100,
    updatedAt: 1_780_000_100,
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    channelId: CHANNEL_ID,
    title: "Open a Cape Town desk",
    summary: "",
    costCentreId: COST_CENTRE_ID,
    requestId: REQUEST_ID,
    ...overrides,
  };
}

/**
 * A working stack: identity, company head, backend build, applied receipt.
 *
 * `loadInitiative` may be a single result reused on every read or an array
 * consumed one per read, which is how the read-back's retry policy is
 * observed rather than assumed.
 */
function stack({ brokerOutcome, loadInitiative } = {}) {
  const calls = { createInitiative: [], submit: [], loadInitiative: [] };
  const queue = Array.isArray(loadInitiative) ? [...loadInitiative] : null;
  const creator = createInitiativeCreator({
    relaySelf: async () => RELAY,
    fetchCompanyHead: async () => companyHeadEvent(),
    createInitiative: async (input) => {
      calls.createInitiative.push(input);
      return {
        initiativeId: INITIATIVE_ID,
        ownerPersonaId: "relay1:horizonlabs:chief-of-staff",
        signedAction: "signed-action",
      };
    },
    broker: {
      submit: async (action) => {
        calls.submit.push(action);
        return (
          brokerOutcome ?? {
            status: "applied",
            receiptEventId: "r".repeat(64),
            headEventId: "h".repeat(64),
            target: "t",
          }
        );
      },
    },
    loadInitiative: async (initiativeId) => {
      calls.loadInitiative.push(initiativeId);
      if (queue) {
        return queue.shift() ?? { ok: true, value: initiative() };
      }
      return loadInitiative ?? { ok: true, value: initiative() };
    },
    delay: async () => {},
    readBackAttempts: 3,
    readBackIntervalMs: 0,
  });
  return { creator, calls };
}

test("a valid draft publishes the signed action and reads the initiative back", async () => {
  const { creator, calls } = stack();
  const created = await creator(draft({ title: "  Open a Cape Town desk  " }));
  assert.equal(created.id, INITIATIVE_ID);
  assert.equal(calls.createInitiative.length, 1);
  // The title reaching the backend is trimmed, not the raw form value.
  assert.equal(calls.createInitiative[0].title, "Open a Cape Town desk");
  assert.equal(calls.createInitiative[0].channelId, CHANNEL_ID);
  assert.equal(calls.createInitiative[0].costCentreId, COST_CENTRE_ID);
  assert.equal(calls.createInitiative[0].relayPubkey, RELAY);
  // An untouched description travels as null, not as an empty string.
  assert.equal(calls.createInitiative[0].summary, null);
  assert.equal(calls.submit.length, 1);
  assert.deepEqual(calls.loadInitiative, [INITIATIVE_ID]);
});

test("an invalid draft never reaches the network", async () => {
  const { creator, calls } = stack();
  await assert.rejects(
    () => creator(draft({ costCentreId: "" })),
    /cost centre/i,
  );
  assert.equal(calls.createInitiative.length, 0);
  assert.equal(calls.submit.length, 0);
});

test("a conflict is treated the same as applied - the initiative already exists", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "conflict",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "This record changed while the request was in flight.",
    },
  });
  const created = await creator(draft());
  assert.equal(created.id, INITIATIVE_ID);
  assert.deepEqual(calls.loadInitiative, [INITIATIVE_ID]);
});

// The relay's idempotency claim on this request id was already won, most
// likely by an earlier attempt at this exact create. The identifier is
// derived from `requestId`, not from which event won the claim, so it names
// the same initiative either way.
test("a superseded submission reads back by initiative id, never by the winning event", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
  });
  const created = await creator(draft());
  assert.equal(created.id, INITIATIVE_ID);
  // Only the coordinate. `getInitiative` has no by-event-id lookup, so a
  // winner event id reaching it would be read as an initiative id and miss.
  assert.deepEqual(calls.loadInitiative, [INITIATIVE_ID]);
});

test("a rejected action surfaces the relay's message rather than pretending success", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "rejected",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "The relay refused this company change.",
    },
  });
  await assert.rejects(() => creator(draft()), /refused this company change/i);
  assert.equal(calls.loadInitiative.length, 0);
});

test("an unanswered action is reported as unresolved, not as a create", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "no-receipt",
      actionEventId: "a".repeat(64),
      message: "The relay has not answered this company change yet.",
    },
  });
  await assert.rejects(() => creator(draft()), /has not answered/i);
  assert.equal(calls.loadInitiative.length, 0);
});

test("a read-back that never finds the head is retried, then fails retry-safe", async () => {
  const { creator, calls } = stack({
    loadInitiative: { ok: false, code: "missing-head", message: "gone" },
  });
  await assert.rejects(() => creator(draft()), /could not be read back/i);
  // Every attempt was spent, because indexing lag is exactly what this waits
  // out.
  assert.equal(calls.loadInitiative.length, 3);
});

test("a head that appears on a later attempt is returned rather than given up on", async () => {
  const { creator, calls } = stack({
    loadInitiative: [
      { ok: false, code: "missing-head", message: "gone" },
      { ok: true, value: initiative() },
    ],
  });
  const created = await creator(draft());
  assert.equal(created.id, INITIATIVE_ID);
  assert.equal(calls.loadInitiative.length, 2);
});

// Retrying these would spend the whole budget on a failure that cannot
// change, then report it as the one thing it is not: a read that was still
// catching up.
test("a head this build cannot parse surfaces its own message without retrying", async () => {
  const { creator, calls } = stack({
    loadInitiative: {
      ok: false,
      code: "invalid-record",
      message: "initiative record shape is invalid",
    },
  });
  await assert.rejects(() => creator(draft()), /record shape is invalid/i);
  assert.equal(calls.loadInitiative.length, 1);
});

test("a relay with no identity surfaces that rather than a read-back timeout", async () => {
  const { creator, calls } = stack({
    loadInitiative: {
      ok: false,
      code: "no-relay-identity",
      message:
        "This community's relay has no stable identity, so it has no company records.",
    },
  });
  await assert.rejects(() => creator(draft()), /no stable identity/i);
  assert.equal(calls.loadInitiative.length, 1);
});

test("a community with no relay identity cannot create anything", async () => {
  const creator = createInitiativeCreator({
    relaySelf: async () => null,
    fetchCompanyHead: async () => {
      throw new Error("must not be reached");
    },
    createInitiative: async () => {
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    loadInitiative: async () => {
      throw new Error("must not be reached");
    },
  });
  await assert.rejects(() => creator(draft()), /no stable identity/i);
});

test("a missing company head stops before anything is signed", async () => {
  let built = false;
  const creator = createInitiativeCreator({
    relaySelf: async () => RELAY,
    fetchCompanyHead: async () => null,
    createInitiative: async () => {
      built = true;
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    loadInitiative: async () => {
      throw new Error("must not be reached");
    },
  });
  await assert.rejects(
    () => creator(draft()),
    /has not described its business/i,
  );
  assert.equal(built, false);
});
