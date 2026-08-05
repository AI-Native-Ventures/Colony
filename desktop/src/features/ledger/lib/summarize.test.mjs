import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLedgerReport } from "../report.ts";
import {
  attentionItems,
  budgetsByPressure,
  budgetUsedPercent,
  costCentresBySpend,
  describeAttribution,
  isOverBudget,
  percentOf,
  recentEntries,
} from "./summarize.ts";

function entry(overrides = {}) {
  return {
    eventId: "a".repeat(64),
    day: "2026-08-03",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    paymentMode: "metered",
    costNanousd: "1000000000",
    originalClassification: "opex",
    effectiveClassification: "opex",
    effectiveAssignment: null,
    attributedBy: { kind: "needsReview" },
    ...overrides,
  };
}

function report(overrides = {}) {
  return parseLedgerReport({
    entries: [],
    totals: { cogs: "0", opex: "0", needsReview: "0" },
    meteredNanousd: "0",
    imputedNanousd: "0",
    byCostCentre: [],
    byDay: [],
    budgetStatus: [],
    exceptions: [],
    unreadableRecords: 0,
    priceBookMissing: false,
    ...overrides,
  });
}

test("a report written before the price basis existed still reads", () => {
  // The fixture carries no priceBasis at all, which is every report the
  // installed app produced before this field. Failing here would break the
  // Spend screen for anyone whose relay is a version behind.
  const parsed = report({ entries: [entry()] });
  assert.equal(parsed.entries[0].priceBasis, null);
});

test("the basis says whether a provider's own rate or the list rate was used", () => {
  const provider = report({ entries: [entry({ priceBasis: "providerRow" })] });
  assert.equal(provider.entries[0].priceBasis, "providerRow");

  const list = report({ entries: [entry({ priceBasis: "listRow" })] });
  assert.equal(list.entries[0].priceBasis, "listRow");
});

test("a cost the provider stated reads as observed, not as a row", () => {
  // No rate was consulted at all, so this must not be mistaken for a list
  // price and marked as an estimate.
  const observed = report({ entries: [entry({ priceBasis: "observed" })] });
  assert.equal(observed.entries[0].priceBasis, "observed");
});

test("an unrecognised basis is refused rather than dropped", () => {
  // Dropping it would silently show a cost as unqualified when the app simply
  // did not understand what qualified it. A rate wrong by a reseller's margin
  // looks exactly like a right one.
  assert.throws(
    () => report({ entries: [entry({ priceBasis: "wholesale" })] }),
    {
      message: /priceBasis is unknown: wholesale/,
    },
  );
  assert.throws(() => report({ entries: [entry({ priceBasis: 7 })] }), {
    message: /priceBasis is unknown: 7/,
  });
});

test("a percentage stays exact past Number.MAX_SAFE_INTEGER", () => {
  // Both sides are larger than 2^53. Converting to number first would lose
  // the ratio; scaling in bigint keeps it.
  const whole = 90_071_992_547_409_930_000n;
  assert.equal(percentOf(whole / 4n, whole), 25);
  assert.equal(percentOf(0n, whole), 0);
});

test("a zero denominator has no percentage rather than zero", () => {
  // 0% would read as "nothing used yet"; there is simply no ratio.
  assert.equal(percentOf(5n, 0n), null);
  assert.equal(
    budgetUsedPercent({
      costCentreId: "web",
      period: "2026-08",
      budgetNanousd: 0n,
      actualNanousd: 5n,
    }),
    null,
  );
});

test("spending past the limit is over budget, spending exactly it is not", () => {
  const at = {
    costCentreId: "web",
    period: "2026-08",
    budgetNanousd: 100n,
    actualNanousd: 100n,
  };
  assert.equal(isOverBudget(at), false);
  assert.equal(isOverBudget({ ...at, actualNanousd: 101n }), true);
});

test("budgets sort by pressure, with zero-limit budgets last", () => {
  const make = (costCentreId, budget, actual) => ({
    costCentreId,
    period: "2026-08",
    budgetNanousd: BigInt(budget),
    actualNanousd: BigInt(actual),
  });
  const sorted = budgetsByPressure([
    make("calm", 1000, 100),
    make("unbounded", 0, 500),
    make("breaking", 1000, 1200),
    make("tight", 1000, 900),
  ]);
  assert.deepEqual(
    sorted.map((status) => status.costCentreId),
    ["breaking", "tight", "calm", "unbounded"],
  );
});

test("cost centres sort by spend, with unattributed money always last", () => {
  // needs-review is the absence of a cost centre, so ranking it among real
  // ones would read as a department by that name.
  const sorted = costCentresBySpend([
    { costCentreId: "needs-review", amountNanousd: 9_000n },
    { costCentreId: "web-delivery", amountNanousd: 500n },
    { costCentreId: "internal-ops", amountNanousd: 700n },
  ]);
  assert.deepEqual(
    sorted.map((total) => total.costCentreId),
    ["internal-ops", "web-delivery", "needs-review"],
  );
});

test("the activity list is newest first", () => {
  // The engine counts oldest-first; a reader wants the opposite.
  const { entries } = report({
    entries: [
      entry({ eventId: "1".repeat(64), day: "2026-08-01" }),
      entry({ eventId: "2".repeat(64), day: "2026-08-02" }),
      entry({ eventId: "3".repeat(64), day: "2026-08-03" }),
    ],
  });
  assert.deepEqual(
    recentEntries(entries, 2).map((item) => item.day),
    ["2026-08-03", "2026-08-02"],
  );
  assert.equal(recentEntries(entries, 10).length, 3);
});

test("unreadable records and a missing price book both block", () => {
  const items = attentionItems(
    report({ unreadableRecords: 2, priceBookMissing: true }),
  );
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.severity === "blocking"));
  assert.match(items[0].title, /2 spend records could not be read/);
});

test("one unpriced model is listed once however many calls it made", () => {
  const unpriced = (eventId, model) => ({
    diagnosis: null,
    exception: { type: "unpricedModel", eventId, model },
  });
  const items = attentionItems(
    report({
      exceptions: [
        unpriced("a".repeat(64), "gpt-5.6"),
        unpriced("b".repeat(64), "gpt-5.6"),
        unpriced("c".repeat(64), "claude-opus-5"),
      ],
    }),
  );
  const titles = items.map((item) => item.title);
  assert.equal(titles.filter((t) => t.includes("gpt-5.6")).length, 1);
  assert.equal(titles.filter((t) => t.includes("claude-opus-5")).length, 1);
});

test("a missing price book replaces per-model notices rather than adding to them", () => {
  // Every model is unpriced when nothing has been priced; listing each one
  // would bury the single fact that fixes all of them.
  const items = attentionItems(
    report({
      priceBookMissing: true,
      exceptions: [
        {
          diagnosis: null,
          exception: {
            type: "unpricedModel",
            eventId: "a".repeat(64),
            model: "gpt-5.6",
          },
        },
      ],
    }),
  );
  assert.equal(items.length, 1);
  assert.match(items[0].title, /No price list/);
});

test("blocking items sort ahead of warnings", () => {
  const items = attentionItems(
    report({
      unreadableRecords: 1,
      totals: { cogs: "0", opex: "0", needsReview: "500" },
    }),
  );
  assert.deepEqual(
    items.map((item) => item.severity),
    ["blocking", "warning"],
  );
});

test("a clean ledger needs no attention", () => {
  assert.deepEqual(attentionItems(report()), []);
});

test("every attribution method reads as a sentence", () => {
  assert.equal(
    describeAttribution({ kind: "explicit" }),
    "Recorded with the work it belonged to",
  );
  assert.equal(
    describeAttribution({ kind: "rule", id: "r1" }),
    "Matched an attribution rule",
  );
  assert.equal(
    describeAttribution({ kind: "correction", id: "c1" }),
    "Corrected by hand",
  );
  assert.equal(
    describeAttribution({ kind: "needsReview" }),
    "Not attributed yet",
  );
});
