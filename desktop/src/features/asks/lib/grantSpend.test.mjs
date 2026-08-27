import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decidedTotalNanoUsd,
  grantSpendFor,
  grantSpendTotals,
  NO_GRANT_SPEND,
} from "./grantSpend.ts";
import { decisionLogsFromEvents } from "./decisionLog.ts";
import { allGrantsFromEvents } from "@/features/agents/delegationGrants.ts";
import {
  KIND_DECISION_LOG,
  KIND_DELEGATION_GRANT,
} from "@/shared/constants/kinds.ts";

const GRANT_ID = "copy-blog-titles";
const OTHER_GRANT_ID = "invoice-vendors";

const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";
const LEAD = "2222222222222222222222222222222222222222222222222222222222222222";

/** A parsed decision log, the shape `decisionLogsFromEvents` produces. */
function decision({
  grantId = GRANT_ID,
  amountNanoUsd = null,
  eventId = "e".repeat(64),
  createdAt = 1_000,
}) {
  return {
    eventId,
    agentPubkey: LEAD,
    createdAt,
    grantId,
    taskIds: ["task-1"],
    decision: "Renewed the illustration vendor",
    undoPath: "buzz vendor renew --undo acme",
    category: "vendor selection",
    amountNanoUsd,
  };
}

/** A kind-44303 event, for the paths that go through the real parser. */
function decisionEvent({
  grantId = GRANT_ID,
  amountNanoUsd,
  eventId = "e".repeat(64),
  createdAt = 1_000,
}) {
  const content = {
    decision: "Renewed the illustration vendor",
    undo_path: "buzz vendor renew --undo acme",
    category: "vendor selection",
  };
  if (amountNanoUsd !== undefined) content.amount_nano_usd = amountNanoUsd;
  return {
    id: eventId,
    pubkey: LEAD,
    created_at: createdAt,
    kind: KIND_DECISION_LOG,
    tags: [
      ["grant", grantId],
      ["task", "task-1"],
    ],
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

/** A kind-30189 grant head, owner-authored so the trust scan accepts it. */
function grantEvent({
  grantId = GRANT_ID,
  active = true,
  capNanoUsd,
  createdAt = 1_000,
}) {
  const content = { category: "vendor selection", scope: "blog art", active };
  if (capNanoUsd !== undefined) content.cap_nano_usd = capNanoUsd;
  return {
    id: `${grantId}-${createdAt}`.padEnd(64, "0"),
    pubkey: OWNER,
    created_at: createdAt,
    kind: KIND_DELEGATION_GRANT,
    tags: [["d", grantId]],
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

test("a grant with no decisions reads as zero, not as missing", () => {
  const totals = grantSpendTotals([]);
  assert.equal(totals.size, 0);

  const spend = grantSpendFor(totals, GRANT_ID);
  assert.deepEqual(spend, { totalNanoUsd: 0n, decisionCount: 0 });
  assert.equal(spend.totalNanoUsd, 0n);
  assert.equal(spend, NO_GRANT_SPEND);
});

test("several decisions under one grant sum to their total", () => {
  const totals = grantSpendTotals([
    decision({ amountNanoUsd: 24_000_000_000, eventId: "a".repeat(64) }),
    decision({ amountNanoUsd: 25_000_000_000, eventId: "b".repeat(64) }),
    decision({ amountNanoUsd: 1_500_000_000, eventId: "c".repeat(64) }),
  ]);

  // $24 + $25 + $1.50 under a $25 per-decision ceiling: every one of them was
  // legal, and the total is twice the number the owner thinks they capped.
  assert.deepEqual(grantSpendFor(totals, GRANT_ID), {
    totalNanoUsd: 50_500_000_000n,
    decisionCount: 3,
  });
});

test("decisions under other grants are excluded", () => {
  const totals = grantSpendTotals([
    decision({ amountNanoUsd: 10_000_000_000, eventId: "a".repeat(64) }),
    decision({
      grantId: OTHER_GRANT_ID,
      amountNanoUsd: 900_000_000_000,
      eventId: "b".repeat(64),
    }),
  ]);

  assert.deepEqual(grantSpendFor(totals, GRANT_ID), {
    totalNanoUsd: 10_000_000_000n,
    decisionCount: 1,
  });
  assert.deepEqual(grantSpendFor(totals, OTHER_GRANT_ID), {
    totalNanoUsd: 900_000_000_000n,
    decisionCount: 1,
  });
});

test("grant ids match case-insensitively, as the log filter does", () => {
  const totals = grantSpendTotals([
    decision({ grantId: "Copy-Blog-Titles", amountNanoUsd: 5_000_000_000 }),
  ]);
  assert.deepEqual(grantSpendFor(totals, "copy-blog-titles"), {
    totalNanoUsd: 5_000_000_000n,
    decisionCount: 1,
  });
});

test("a decision that declared no amount counts but adds nothing", () => {
  const totals = grantSpendTotals([
    decision({ amountNanoUsd: null, eventId: "a".repeat(64) }),
    decision({ amountNanoUsd: 2_000_000_000, eventId: "b".repeat(64) }),
  ]);
  assert.deepEqual(grantSpendFor(totals, GRANT_ID), {
    totalNanoUsd: 2_000_000_000n,
    decisionCount: 2,
  });
});

test("the total stays exact past 2^53 nanoUSD, where a number would not", () => {
  const amounts = [9_007_199_254_740_991, 1, 1];
  const totals = grantSpendTotals(
    amounts.map((amountNanoUsd, index) =>
      decision({ amountNanoUsd, eventId: String(index).repeat(64) }),
    ),
  );

  const exact = 9_007_199_254_740_993n;
  assert.equal(grantSpendFor(totals, GRANT_ID).totalNanoUsd, exact);

  // The same sum in JS numbers loses the last nanoUSD outright. This is why
  // the total is bigint end to end, not a convenience.
  const naive = amounts.reduce((sum, amount) => sum + amount, 0);
  assert.notEqual(BigInt(naive), exact);
});

test("a revoked grant keeps the history decided while it was live", () => {
  // Same `d` tag republished with active: false. The record stays, and so
  // does everything that was decided under it.
  const grants = allGrantsFromEvents(
    [
      grantEvent({ capNanoUsd: 25_000_000_000, createdAt: 1_000 }),
      grantEvent({
        active: false,
        capNanoUsd: 25_000_000_000,
        createdAt: 2_000,
      }),
    ],
    new Set([OWNER]),
  );
  assert.equal(grants.length, 1);
  const revoked = grants[0];
  assert.equal(revoked.active, false);

  const totals = grantSpendTotals(
    decisionLogsFromEvents([
      decisionEvent({
        amountNanoUsd: 25_000_000_000,
        eventId: "a".repeat(64),
        createdAt: 1_100,
      }),
      decisionEvent({
        amountNanoUsd: 20_000_000_000,
        eventId: "b".repeat(64),
        createdAt: 1_200,
      }),
    ]),
  );

  assert.deepEqual(grantSpendFor(totals, revoked.grantId), {
    totalNanoUsd: 45_000_000_000n,
    decisionCount: 2,
  });
});

test("real events parse and total through the shared reader", () => {
  const totals = grantSpendTotals(
    decisionLogsFromEvents([
      decisionEvent({ amountNanoUsd: 1_250_000_000, eventId: "a".repeat(64) }),
      decisionEvent({ eventId: "b".repeat(64) }),
      // Malformed: dropped by the parser, so it cannot inflate a total.
      { ...decisionEvent({ eventId: "c".repeat(64) }), content: "{not json" },
    ]),
  );
  assert.deepEqual(grantSpendFor(totals, GRANT_ID), {
    totalNanoUsd: 1_250_000_000n,
    decisionCount: 2,
  });
});

test("decidedTotalNanoUsd sums one already-filtered list", () => {
  assert.equal(decidedTotalNanoUsd([]), 0n);
  assert.equal(
    decidedTotalNanoUsd([
      decision({ amountNanoUsd: 3_000_000_000, eventId: "a".repeat(64) }),
      decision({
        grantId: OTHER_GRANT_ID,
        amountNanoUsd: 4_000_000_000,
        eventId: "b".repeat(64),
      }),
      decision({ amountNanoUsd: null, eventId: "c".repeat(64) }),
    ]),
    7_000_000_000n,
  );
});
