import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decisionLogsFromEvents,
  filterDecisionLogs,
  parseDecisionLogEvent,
} from "./decisionLog.ts";
import { KIND_DECISION_LOG } from "@/shared/constants/kinds.ts";

const GRANT_ID = "spend-blog";
const OTHER_GRANT_ID = "hire-freelance";
const TASK_ID = "task-abc";

const LEAD = "1111111111111111111111111111111111111111111111111111111111111111";
const EXEC = "2222222222222222222222222222222222222222222222222222222222222222";

/**
 * A kind-44303 decision log. Authored by the DECIDING AGENT (the signer is
 * the leader or executive that made the call), never by an owner.
 */
function logEvent({
  author = LEAD,
  createdAt = 1_000,
  grantId = GRANT_ID,
  taskIds = [TASK_ID],
  decision = "Switch blog illustrations to the Acme vendor",
  undoPath = "buzz vendor switch-back acme-prev",
  category = "vendor selection",
  amountNanoUsd,
  eventId = "e".repeat(64),
}) {
  const content = { decision, undo_path: undoPath, category };
  if (amountNanoUsd !== undefined) {
    content.amount_nano_usd = amountNanoUsd;
  }
  const tags = [["grant", grantId]];
  for (const taskId of taskIds) tags.push(["task", taskId]);
  return {
    id: eventId,
    pubkey: author,
    created_at: createdAt,
    kind: KIND_DECISION_LOG,
    tags,
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

test("a well-formed decision log parses to its fields", () => {
  const log = parseDecisionLogEvent(
    logEvent({ amountNanoUsd: 50_000_000_000 }),
  );
  assert.deepEqual(log, {
    eventId: "e".repeat(64),
    agentPubkey: LEAD,
    createdAt: 1_000,
    grantId: GRANT_ID,
    taskIds: [TASK_ID],
    decision: "Switch blog illustrations to the Acme vendor",
    undoPath: "buzz vendor switch-back acme-prev",
    category: "vendor selection",
    amountNanoUsd: 50_000_000_000,
  });
});

test("category is lowercased on parse", () => {
  const log = parseDecisionLogEvent(logEvent({ category: "Vendor Selection" }));
  assert.equal(log?.category, "vendor selection");
});

test("a missing or empty undo path parses to null", () => {
  // Spec: no stateable undo path means no autonomy. The relay refuses such
  // an event at ingest; a client seeing one must not render it either.
  const noField = logEvent({});
  noField.content = JSON.stringify({
    decision: "x",
    category: "copy_change",
  });
  assert.equal(parseDecisionLogEvent(noField), null);

  const empty = logEvent({ undoPath: "   " });
  assert.equal(parseDecisionLogEvent(empty), null);
});

test("malformed logs parse to null rather than throwing", () => {
  const badJson = logEvent({});
  badJson.content = "{not json";
  assert.equal(parseDecisionLogEvent(badJson), null);

  assert.equal(parseDecisionLogEvent({ ...logEvent({}), kind: 9 }), null);

  const noGrantTag = logEvent({});
  noGrantTag.tags = [["task", TASK_ID]];
  assert.equal(parseDecisionLogEvent(noGrantTag), null);

  const twoGrantTags = logEvent({});
  twoGrantTags.tags = [
    ["grant", GRANT_ID],
    ["grant", OTHER_GRANT_ID],
    ["task", TASK_ID],
  ];
  assert.equal(parseDecisionLogEvent(twoGrantTags), null);

  const noTaskTags = logEvent({ taskIds: [] });
  assert.equal(parseDecisionLogEvent(noTaskTags), null);

  const emptyDecision = logEvent({ decision: "" });
  assert.equal(parseDecisionLogEvent(emptyDecision), null);

  const emptyCategory = logEvent({ category: "  " });
  assert.equal(parseDecisionLogEvent(emptyCategory), null);
});

test("a negative or non-integer amount parses to null", () => {
  assert.equal(parseDecisionLogEvent(logEvent({ amountNanoUsd: -1 })), null);
  assert.equal(parseDecisionLogEvent(logEvent({ amountNanoUsd: 1.5 })), null);
});

test("an absent amount parses as null money moved", () => {
  const log = parseDecisionLogEvent(logEvent({}));
  assert.equal(log?.amountNanoUsd, null);
});

test("multiple task ids round-trip in order", () => {
  const log = parseDecisionLogEvent(logEvent({ taskIds: ["t2", "t1", "t3"] }));
  assert.deepEqual(log?.taskIds, ["t2", "t1", "t3"]);
});

test("decision logs read newest-first and malformed entries are dropped", () => {
  const logs = decisionLogsFromEvents([
    logEvent({ createdAt: 500 }),
    logEvent({ createdAt: 900, author: EXEC, grantId: OTHER_GRANT_ID }),
    logEvent({ createdAt: 700, decision: "" }),
  ]);
  assert.deepEqual(
    logs.map((log) => log.createdAt),
    [900, 500],
  );
  assert.equal(logs[0].agentPubkey, EXEC);
});

function filterFixture() {
  return [
    logEvent({
      createdAt: 100,
      author: LEAD,
      grantId: GRANT_ID,
      category: "vendor selection",
    }),
    logEvent({
      createdAt: 200,
      author: EXEC,
      grantId: OTHER_GRANT_ID,
      category: "copy_change",
    }),
  ];
}

test("filtering by agent keeps only that agent's decisions", () => {
  const filtered = filterDecisionLogs(decisionLogsFromEvents(filterFixture()), {
    agentPubkey: EXEC,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].agentPubkey, EXEC);
});

test("filtering by grant id is case-insensitive", () => {
  const filtered = filterDecisionLogs(decisionLogsFromEvents(filterFixture()), {
    grantId: "HIRE-FREELANCE",
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].grantId, OTHER_GRANT_ID);
});

test("filtering by category is case-insensitive", () => {
  const filtered = filterDecisionLogs(decisionLogsFromEvents(filterFixture()), {
    category: "Copy_Change",
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].category, "copy_change");
});

test("filters combine and empty filters return everything", () => {
  const parsed = decisionLogsFromEvents(filterFixture());
  assert.equal(filterDecisionLogs(parsed, {}).length, 2);
  const combined = filterDecisionLogs(parsed, {
    agentPubkey: LEAD,
    grantId: OTHER_GRANT_ID,
  });
  assert.equal(combined.length, 0);
});
