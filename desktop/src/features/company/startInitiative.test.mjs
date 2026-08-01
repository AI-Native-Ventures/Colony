import assert from "node:assert/strict";
import { test } from "node:test";

import { createInitiativeStarter } from "./startInitiative.ts";
import {
  isInitiativeAction,
  readInitiativeCardAction,
  resolveInitiativeActionInputs,
} from "./initiativeCard.ts";

const RELAY = "a".repeat(64);
const COMPANY_ID = "horizonlabs";
const INITIATIVE_ID = "horizonlabs:launch-outbound";

function head(kind, id, createdAt = 1_780_000_100) {
  return {
    id: `${kind}${id}${createdAt}`.padEnd(64, "0").slice(0, 64),
    pubkey: RELAY,
    created_at: createdAt,
    kind,
    tags: [["d", id]],
    content: "{}",
    sig: "0".repeat(128),
  };
}

/**
 * A relay that walks the real ladder: each applied transition moves the status
 * on, so the driver is exercised against state that actually changes rather
 * than a stub that always answers the same way.
 */
function ladder({ failAt = null } = {}) {
  const calls = [];
  let status = "proposed";
  let published = 0;
  const advance = async (input) => {
    calls.push({ status, intent: input.intent });
    if (input.intent === "decline") {
      return status === "cancelled"
        ? {
            initiativeId: INITIATIVE_ID,
            status,
            nextStatus: null,
            taskId: null,
            owningTeamId: null,
            signedAction: null,
            settled: true,
          }
        : {
            initiativeId: INITIATIVE_ID,
            status,
            nextStatus: "cancelled",
            taskId: null,
            owningTeamId: null,
            signedAction: `action:${status}:cancelled`,
            settled: false,
          };
    }
    if (status === "proposed") {
      return {
        initiativeId: INITIATIVE_ID,
        status,
        nextStatus: "approved",
        taskId: null,
        owningTeamId: null,
        signedAction: "action:proposed:approved",
        settled: false,
      };
    }
    if (status === "approved") {
      return {
        initiativeId: INITIATIVE_ID,
        status,
        nextStatus: "active",
        taskId: null,
        owningTeamId: null,
        signedAction: "action:approved:active",
        settled: false,
      };
    }
    return {
      initiativeId: INITIATIVE_ID,
      status,
      nextStatus: null,
      taskId: `${INITIATIVE_ID}:kickoff`,
      owningTeamId: "team:sales",
      signedAction: "action:active:kickoff",
      settled: true,
    };
  };

  const broker = {
    submit: async (action) => {
      published += 1;
      if (failAt && published === failAt.attempt) return failAt.outcome;
      if (action.endsWith(":cancelled")) status = "cancelled";
      else if (action.endsWith(":approved")) status = "approved";
      else if (action.endsWith(":active")) status = "active";
      return {
        status: "applied",
        receiptEventId: "r".repeat(64),
        headEventId: "h".repeat(64),
        target: `30180:${RELAY}:${INITIATIVE_ID}`,
      };
    },
  };

  let reads = 0;
  const starter = createInitiativeStarter({
    relaySelf: async () => RELAY,
    fetchHead: async (kind, id) => {
      reads += 1;
      return head(kind, id, 1_780_000_100 + reads);
    },
    advance,
    broker,
  });

  return { starter, calls, published: () => published };
}

test("starting a proposed initiative walks approve, activate, then kick off", async () => {
  const { starter, calls } = ladder();
  const outcome = await starter({
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "start",
  });
  assert.deepEqual(outcome, {
    status: "started",
    initiativeId: INITIATIVE_ID,
    taskId: `${INITIATIVE_ID}:kickoff`,
    owningTeamId: "team:sales",
  });
  assert.deepEqual(
    calls.map((call) => call.status),
    ["proposed", "approved", "active"],
  );
});

// Each rung is compare-and-set against the head that was just read. Reusing the
// first read would pin every write to a head the previous write replaced, and
// every rung after the first would come back as a conflict.
test("the initiative head is re-read before every publish", async () => {
  const reads = [];
  const starter = createInitiativeStarter({
    relaySelf: async () => RELAY,
    fetchHead: async (kind, id) => {
      reads.push(kind);
      return head(kind, id, 1_780_000_100 + reads.length);
    },
    advance: async () => ({
      initiativeId: INITIATIVE_ID,
      status: "proposed",
      nextStatus: "approved",
      taskId: null,
      owningTeamId: null,
      signedAction: "action",
      settled: false,
    }),
    broker: {
      submit: async () => ({
        status: "applied",
        receiptEventId: "r".repeat(64),
        headEventId: "h".repeat(64),
        target: "t",
      }),
    },
  });
  await starter({
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "start",
  });
  // One company read, then one initiative read per rung attempted.
  assert.equal(reads.filter((kind) => kind === 30179).length, 1);
  assert.equal(reads.filter((kind) => kind === 30180).length, 4);
});

test("a conflicted rung stops the run and says trying again is safe", async () => {
  const { starter, published } = ladder({
    failAt: {
      attempt: 2,
      outcome: {
        status: "conflict",
        receiptEventId: "r".repeat(64),
        target: "t",
        message: "This record changed while the request was in flight.",
      },
    },
  });
  const outcome = await starter({
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "start",
  });
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.message, /again is safe/i);
  // It stopped where it failed rather than pressing on to the kickoff task.
  assert.equal(published(), 2);
});

test("an unanswered action is reported as unresolved, not as a start", async () => {
  const { starter } = ladder({
    failAt: {
      attempt: 1,
      outcome: {
        status: "no-receipt",
        actionEventId: "a".repeat(64),
        message: "The relay has not answered this company change yet.",
      },
    },
  });
  const outcome = await starter({
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "start",
  });
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.message, /has not answered/i);
});

test("declining cancels in one publish", async () => {
  const { starter, calls, published } = ladder();
  const outcome = await starter({
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "decline",
  });
  assert.deepEqual(outcome, {
    status: "declined",
    initiativeId: INITIATIVE_ID,
  });
  assert.equal(published(), 1);
  assert.deepEqual(
    calls.map((call) => call.status),
    ["proposed", "cancelled"],
  );
});

test("a community with no relay identity cannot start anything", async () => {
  const starter = createInitiativeStarter({
    relaySelf: async () => null,
    fetchHead: async () => null,
    advance: async () => {
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
  });
  await assert.rejects(
    () =>
      starter({
        initiativeId: INITIATIVE_ID,
        companyId: COMPANY_ID,
        intent: "start",
      }),
    /no stable identity/i,
  );
});

test("a missing company head stops before anything is signed", async () => {
  let advanced = false;
  const starter = createInitiativeStarter({
    relaySelf: async () => RELAY,
    fetchHead: async (kind, id) => (kind === 30179 ? null : head(kind, id)),
    advance: async () => {
      advanced = true;
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
  });
  await assert.rejects(
    () =>
      starter({
        initiativeId: INITIATIVE_ID,
        companyId: COMPANY_ID,
        intent: "start",
      }),
    /no company record/i,
  );
  assert.equal(advanced, false);
});

const CARD = {
  initiative_id: INITIATIVE_ID,
  company_id: COMPANY_ID,
  title: "Launch outbound",
  summary: "Open a first outbound channel.",
  status: "proposed",
  owner: "Sales lead",
  cost_centre: "Company coordination",
  commercial_purpose: "sales",
};

test("both card actions resolve their inputs from the card itself", () => {
  const inputs = resolveInitiativeActionInputs(CARD);
  assert.deepEqual(inputs.get("initiative.start"), {
    initiative_id: INITIATIVE_ID,
  });
  assert.deepEqual(inputs.get("initiative.decline"), {
    initiative_id: INITIATIVE_ID,
  });
  assert.equal(isInitiativeAction("initiative.start"), true);
  assert.equal(isInitiativeAction("company-blueprint.approve"), false);
});

// A card is authored elsewhere, so a malformed one is an expected input. Acting
// on a partial card would send the backend an identifier nothing can resolve.
test("a malformed card yields no action", () => {
  for (const [label, data] of [
    ["null", null],
    ["empty", {}],
    ["missing company", { ...CARD, company_id: undefined }],
    ["blank initiative", { ...CARD, initiative_id: "" }],
    ["uppercase initiative", { ...CARD, initiative_id: "Horizonlabs:X" }],
    ["initiative with a space", { ...CARD, initiative_id: "horizon labs" }],
    ["initiative too long", { ...CARD, initiative_id: `h${"a".repeat(128)}` }],
    ["initiative not a string", { ...CARD, initiative_id: 12 }],
  ]) {
    assert.equal(
      readInitiativeCardAction(data, "initiative.start"),
      null,
      `${label} must not yield an action`,
    );
    assert.equal(resolveInitiativeActionInputs(data).size, 0, label);
  }
});

test("an action id from another Block is never read as an initiative action", () => {
  assert.equal(readInitiativeCardAction(CARD, "approval.approve"), null);
  assert.deepEqual(readInitiativeCardAction(CARD, "initiative.decline"), {
    initiativeId: INITIATIVE_ID,
    companyId: COMPANY_ID,
    intent: "decline",
  });
});
