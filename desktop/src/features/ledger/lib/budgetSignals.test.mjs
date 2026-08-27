import assert from "node:assert/strict";
import { test } from "node:test";

import {
  budgetExceededKey,
  budgetExceededSignals,
  mergeBudgetNotificationKeys,
} from "./budgetSignals.ts";

function status(overrides = {}) {
  return {
    actualNanousd: 0n,
    budgetNanousd: 500_000_000_000n,
    costCentreId: "eng",
    period: "2026-08",
    ...overrides,
  };
}

test("a budget that has been passed produces one signal", () => {
  const signals = budgetExceededSignals({
    delivered: new Set(),
    statuses: [status({ actualNanousd: 520_000_000_000n })],
  });

  assert.equal(signals.length, 1);
  assert.equal(signals[0].title, "eng is over budget for 2026-08");
  assert.match(signals[0].body, /\$520\.00 spent against a \$500\.00 budget/);
});

test("the alert never implies a budget stopped anything", () => {
  // Colony records spend against a budget; the relay does not refuse a call
  // for passing one. An alert that read as enforcement would buy false
  // confidence at exactly the moment money is running.
  const [signal] = budgetExceededSignals({
    delivered: new Set(),
    statuses: [status({ actualNanousd: 520_000_000_000n })],
  });
  assert.match(signal.body, /Nothing has been stopped/);
  assert.match(signal.body, /does not enforce/);
});

test("a budget inside its limit says nothing", () => {
  assert.deepEqual(
    budgetExceededSignals({
      delivered: new Set(),
      statuses: [
        status({ actualNanousd: 499_999_999_999n }),
        status({ actualNanousd: 500_000_000_000n }),
      ],
    }),
    [],
  );
});

test("one crossing is announced once, however often it is checked", () => {
  const first = status({ actualNanousd: 520_000_000_000n });
  const delivered = new Set([budgetExceededKey(first)]);
  assert.deepEqual(budgetExceededSignals({ delivered, statuses: [first] }), []);
});

test("a zero-limit budget is not tripped by the first penny", () => {
  assert.deepEqual(
    budgetExceededSignals({
      delivered: new Set(),
      statuses: [status({ actualNanousd: 1n, budgetNanousd: 0n })],
    }),
    [],
  );
});

test("each cost centre and period is its own alert", () => {
  const signals = budgetExceededSignals({
    delivered: new Set(),
    statuses: [
      status({ actualNanousd: 600_000_000_000n }),
      status({ actualNanousd: 600_000_000_000n, period: "2026-07" }),
      status({ actualNanousd: 600_000_000_000n, costCentreId: "sales" }),
    ],
  });
  assert.deepEqual(signals.map((signal) => signal.key).sort(), [
    "over:eng:2026-07",
    "over:eng:2026-08",
    "over:sales:2026-08",
  ]);
});

test("amounts past 2^53 nanoUSD are stated exactly", () => {
  const [signal] = budgetExceededSignals({
    delivered: new Set(),
    statuses: [
      status({
        actualNanousd: 18_014_398_509_481_986n,
        budgetNanousd: 9_007_199_254_740_993n,
      }),
    ],
  });
  assert.match(
    signal.body,
    /\$18,014,398\.51 spent against a \$9,007,199\.25 budget/,
  );
});

test("merging delivered keys never loses one and never duplicates", () => {
  assert.deepEqual(mergeBudgetNotificationKeys(["a"], ["a"]), ["a"]);
  assert.deepEqual(mergeBudgetNotificationKeys(["a"], ["b"]), ["a", "b"]);
  assert.deepEqual(mergeBudgetNotificationKeys([], []), []);
});
