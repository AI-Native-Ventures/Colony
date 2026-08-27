import assert from "node:assert/strict";
import { test } from "node:test";

import { formatNanousd } from "./contracts.ts";
import { describeJobSpan, jobSpend } from "./jobSpend.ts";

function assignment(overrides = {}) {
  return {
    clientOrganizationId: null,
    commercialPurpose: "internalProduct",
    companyId: "colony",
    costCentreId: "eng",
    owningTeamId: "platform",
    taskId: null,
    ...overrides,
  };
}

function entry(overrides = {}) {
  const { assign, ...rest } = overrides;
  return {
    attributedBy: { kind: "rule", id: "r1" },
    costNanousd: 1_000_000_000n,
    day: "2026-08-25",
    effectiveAssignment: assign === null ? null : assignment(assign),
    effectiveClassification: "opex",
    eventId: "ab".repeat(32),
    model: "claude-sonnet-4-5",
    originalClassification: "opex",
    paymentMode: "metered",
    priceBasis: "listRow",
    provider: "anthropic",
    source: "wire",
    ...rest,
  };
}

test("a job's cost is the sum of the calls recorded against it", () => {
  // The sentence this whole module exists to make sayable.
  const summary = jobSpend([
    entry({
      assign: { taskId: "tuesday-research" },
      costNanousd: 1_600_000_000n,
    }),
    entry({
      assign: { taskId: "tuesday-research" },
      costNanousd: 500_000_000n,
    }),
  ]);

  assert.equal(summary.jobs.length, 1);
  assert.equal(summary.jobs[0].taskId, "tuesday-research");
  assert.equal(formatNanousd(summary.jobs[0].costNanousd), "$2.10");
  assert.equal(summary.jobs[0].callCount, 2);
});

test("jobs are ordered by cost, most expensive first", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "small" }, costNanousd: 1n }),
    entry({ assign: { taskId: "large" }, costNanousd: 900_000_000_000n }),
    entry({ assign: { taskId: "middle" }, costNanousd: 2_000_000_000n }),
  ]);
  assert.deepEqual(
    summary.jobs.map((job) => job.taskId),
    ["large", "middle", "small"],
  );
});

test("an unpriced call is counted but never costed as zero", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "j1" }, costNanousd: 2_000_000_000n }),
    entry({ assign: { taskId: "j1" }, costNanousd: null }),
  ]);

  assert.equal(summary.jobs[0].costNanousd, 2_000_000_000n);
  assert.equal(summary.jobs[0].callCount, 2);
  assert.equal(summary.jobs[0].unpricedCallCount, 1);
});

test("spend that names no job is reported, not dropped", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "j1" }, costNanousd: 1_000_000_000n }),
    entry({ costNanousd: 4_000_000_000n }),
    entry({ assign: null, costNanousd: 5_000_000_000n }),
    entry({ assign: { taskId: "   " }, costNanousd: 1_000_000_000n }),
  ]);

  assert.equal(summary.jobs.length, 1);
  assert.equal(summary.unassignedCallCount, 3);
  assert.equal(formatNanousd(summary.unassignedNanousd), "$10.00");
});

test("unassigned spend with unpriced calls is a stated floor, never zero", () => {
  // An unpriced call is real work with no rate on file. Summed as zero it
  // would let the footnote say "$0.00 of spend across 3 calls", which reads
  // as three free calls rather than three uncostable ones.
  const summary = jobSpend([
    entry({ costNanousd: 4_000_000_000n }),
    entry({ costNanousd: null }),
    entry({ assign: null, costNanousd: null }),
  ]);

  assert.equal(summary.unassignedCallCount, 3);
  assert.equal(summary.unassignedUnpricedCallCount, 2);
  assert.equal(summary.unassignedNanousd, 4_000_000_000n);
});

test("a job carries the cost centres, clients and models behind it", () => {
  const summary = jobSpend([
    entry({
      assign: {
        clientOrganizationId: "acme",
        costCentreId: "eng",
        taskId: "j",
      },
      model: "claude-sonnet-4-5",
    }),
    entry({
      assign: {
        clientOrganizationId: "acme",
        costCentreId: "research",
        taskId: "j",
      },
      model: "gpt-5.6-sol",
    }),
  ]);

  assert.deepEqual(summary.jobs[0].costCentreIds, ["eng", "research"]);
  assert.deepEqual(summary.jobs[0].clientOrganizationIds, ["acme"]);
  assert.deepEqual(summary.jobs[0].models, [
    "claude-sonnet-4-5",
    "gpt-5.6-sol",
  ]);
});

test("a job's span is the days it actually ran, in order", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "j" }, day: "2026-08-27" }),
    entry({ assign: { taskId: "j" }, day: "2026-08-04" }),
    entry({ assign: { taskId: "j" }, day: "2026-08-19" }),
  ]);

  assert.equal(summary.jobs[0].firstDay, "2026-08-04");
  assert.equal(summary.jobs[0].lastDay, "2026-08-27");
  assert.equal(describeJobSpan(summary.jobs[0]), "2026-08-04 to 2026-08-27");
});

test("a one-day job says one day rather than the same date twice", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "j" }, day: "2026-08-04" }),
  ]);
  assert.equal(describeJobSpan(summary.jobs[0]), "2026-08-04");
});

test("a job's total past 2^53 nanoUSD stays exact", () => {
  const summary = jobSpend([
    entry({ assign: { taskId: "big" }, costNanousd: 9_007_199_254_740_993n }),
    entry({ assign: { taskId: "big" }, costNanousd: 9_007_199_254_740_993n }),
  ]);
  assert.equal(summary.jobs[0].costNanousd, 18_014_398_509_481_986n);
  assert.equal(formatNanousd(summary.jobs[0].costNanousd), "$18,014,398.51");
});

test("no entries at all is an empty summary, not a zeroed one", () => {
  const summary = jobSpend([]);
  assert.deepEqual(summary.jobs, []);
  assert.equal(summary.unassignedCallCount, 0);
  assert.equal(summary.unassignedNanousd, 0n);
});
