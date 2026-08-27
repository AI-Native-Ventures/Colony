import assert from "node:assert/strict";
import { test } from "node:test";

import { formatNanousd } from "./contracts.ts";
import {
  localMidnightBoundaries,
  priceAgent,
  priceTokens,
  priceUsageSeries,
  selectRate,
} from "./agentSpend.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A reported counter that is present and complete. */
function known(value) {
  return { incomplete: false, value: String(value) };
}

/** A counter no event in the scope reported. Absent, which is not zero. */
const ABSENT = { incomplete: false, value: null };

/** A counter the accounting ladder could not complete. */
const INCOMPLETE = { incomplete: true, value: null };

/**
 * Published vendor rates, as the book stores them: nanoUSD per million
 * tokens. $3 input, $0.30 cache read, $3.75 5-minute cache write, $15 output
 * is Anthropic's Sonnet card, which is what makes the arithmetic below
 * checkable against a real price page.
 */
const SONNET_RATES = {
  cacheRead: 300_000_000n,
  cacheWrite1h: 6_000_000_000n,
  cacheWrite5m: 3_750_000_000n,
  input: 3_000_000_000n,
  output: 15_000_000_000n,
};

function rates(overrides = {}) {
  const merged = { ...SONNET_RATES, ...overrides };
  return {
    cacheReadNanousdPerMtok: merged.cacheRead,
    cacheWrite1hNanousdPerMtok: merged.cacheWrite1h,
    cacheWrite5mNanousdPerMtok: merged.cacheWrite5m,
    inputNanousdPerMtok: merged.input,
    outputNanousdPerMtok: merged.output,
  };
}

function entry(overrides = {}) {
  return {
    conditioned: false,
    effectiveFrom: 1_700_000_000,
    model: "claude-sonnet-4-5",
    note: null,
    origin: "owner",
    rates: rates(),
    ...overrides,
  };
}

function usage(overrides = {}) {
  return {
    cacheReadTokens: ABSENT,
    cacheWriteTokens: ABSENT,
    estimatedCostUsd: { incomplete: false, value: null },
    freshInputTokens: ABSENT,
    inputTokens: ABSENT,
    outputTokens: ABSENT,
    totalTokens: ABSENT,
    ...overrides,
  };
}

function modelUsage(overrides = {}) {
  return {
    harness: "claude-code",
    hasUnknownUsage: false,
    model: "claude-sonnet-4-5",
    reportCount: 1,
    usage: usage(),
    ...overrides,
  };
}

function agent(overrides = {}) {
  return {
    agentPubkey: "aa".repeat(32),
    buckets: [],
    hasUnknownUsage: false,
    models: [],
    reportCount: 0,
    usage: usage(),
    ...overrides,
  };
}

const NOW = 1_800_000_000;

// ── The join itself ─────────────────────────────────────────────────────────

test("itemized tokens meet their own rates, and the total is exact", () => {
  // 1,000,000 fresh input at $3, 2,000,000 cache reads at $0.30,
  // 500,000 cache writes at $3.75 and 100,000 output at $15:
  // $3.00 + $0.60 + $1.875 + $1.50 = $6.975.
  const cost = priceTokens(rates(), {
    cacheRead: 2_000_000n,
    cacheWrite: 500_000n,
    inputUncached: 1_000_000n,
    output: 100_000n,
  });
  assert.equal(cost, 6_975_000_000n);
  assert.equal(formatNanousd(cost), "$6.98");
});

test("a fraction of a nanoUSD rounds once, at the end, half up", () => {
  // One token at $3 per million tokens is 3,000 nanoUSD exactly; one token
  // at a rate of 1 nanoUSD per million tokens is half a nanoUSD, which is
  // the only place the ledger rounds.
  assert.equal(
    priceTokens(
      rates({ input: 1n, cacheRead: 0n, cacheWrite5m: 0n, output: 0n }),
      {
        cacheRead: 0n,
        cacheWrite: 0n,
        inputUncached: 500_000n,
        output: 0n,
      },
    ),
    1n,
  );
  assert.equal(
    priceTokens(
      rates({ input: 1n, cacheRead: 0n, cacheWrite5m: 0n, output: 0n }),
      {
        cacheRead: 0n,
        cacheWrite: 0n,
        inputUncached: 499_999n,
        output: 0n,
      },
    ),
    0n,
  );
});

test("an agent's whole window prices from its per-model rows", () => {
  const priced = priceAgent(
    agent({
      models: [
        modelUsage({
          reportCount: 4,
          usage: usage({
            cacheReadTokens: known(2_000_000),
            cacheWriteTokens: known(500_000),
            freshInputTokens: known(1_000_000),
            inputTokens: known(3_500_000),
            outputTokens: known(100_000),
          }),
        }),
      ],
      reportCount: 4,
    }),
    { entries: [entry()] },
    NOW,
  );

  assert.equal(priced.costNanousd, 6_975_000_000n);
  assert.equal(formatNanousd(priced.costNanousd), "$6.98");
  assert.deepEqual(priced.unpricedModels, []);
  assert.equal(priced.hasEstimatedSplit, false);
  assert.equal(priced.hasUnreadableUsage, false);
  assert.equal(priced.models[0].basis, "itemized");
});

test("an unsplit input total is priced at the uncached rate and marked", () => {
  // The harness reported a total input count but no cache breakdown, so the
  // split cannot be recovered. Every input token meets the uncached rate and
  // the row says the figure rests on that.
  const priced = priceAgent(
    agent({
      models: [
        modelUsage({
          usage: usage({
            inputTokens: known(3_500_000),
            outputTokens: known(100_000),
          }),
        }),
      ],
    }),
    { entries: [entry()] },
    NOW,
  );

  // 3,500,000 at $3 plus 100,000 at $15 is $10.50 + $1.50.
  assert.equal(priced.costNanousd, 12_000_000_000n);
  assert.equal(priced.hasEstimatedSplit, true);
  assert.equal(priced.models[0].basis, "unsplitInput");
});

// ── Money that no price covers ──────────────────────────────────────────────

test("a model with no price on file costs null, never zero", () => {
  const priced = priceAgent(
    agent({
      models: [
        modelUsage({
          model: "some-unlisted-model",
          usage: usage({
            inputTokens: known(1_000_000),
            outputTokens: known(1_000_000),
          }),
        }),
      ],
    }),
    { entries: [entry()] },
    NOW,
  );

  assert.equal(priced.models[0].costNanousd, null);
  assert.equal(priced.models[0].unknownReason, "noPrice");
  assert.deepEqual(priced.unpricedModels, ["some-unlisted-model"]);
  // The agent's own figure is a floor over what could be priced, and the
  // unpriced model is named rather than folded in as free work.
  assert.equal(priced.costNanousd, 0n);
});

test("an unpriced model leaves the rest of the agent's spend countable", () => {
  const priced = priceAgent(
    agent({
      models: [
        modelUsage({
          usage: usage({
            inputTokens: known(1_000_000),
            outputTokens: known(0),
          }),
        }),
        modelUsage({
          model: "some-unlisted-model",
          usage: usage({
            inputTokens: known(9_000_000),
            outputTokens: known(9_000_000),
          }),
        }),
      ],
    }),
    { entries: [entry()] },
    NOW,
  );

  assert.equal(priced.costNanousd, 3_000_000_000n);
  assert.deepEqual(priced.unpricedModels, ["some-unlisted-model"]);
});

test("tokens that were never reported are unknown, not free", () => {
  const priced = priceAgent(
    agent({
      models: [
        modelUsage({ usage: usage({ outputTokens: INCOMPLETE }) }),
        modelUsage({ model: null }),
      ],
    }),
    { entries: [entry()] },
    NOW,
  );

  const reasons = priced.models.map((model) => model.unknownReason).sort();
  assert.deepEqual(reasons, ["tokensNotReported", "unnamedModel"]);
  assert.equal(priced.costNanousd, 0n);
  assert.equal(priced.hasUnreadableUsage, true);
  // Neither is an unpriced model: publishing a rate would not fix either.
  assert.deepEqual(priced.unpricedModels, []);
});

test("an agent with no usage at all reports nothing, and says so", () => {
  const priced = priceAgent(agent(), { entries: [entry()] }, NOW);
  assert.equal(priced.costNanousd, 0n);
  assert.deepEqual(priced.models, []);
  assert.deepEqual(priced.unpricedModels, []);
  assert.equal(priced.hasUnreadableUsage, false);
  assert.equal(priced.reportCount, 0);
});

test("no price book at all is reported as such, not as free work", () => {
  const spend = priceUsageSeries(
    {
      agents: [
        agent({
          models: [
            modelUsage({
              usage: usage({
                inputTokens: known(1_000_000),
                outputTokens: known(1_000_000),
              }),
            }),
          ],
        }),
      ],
      buckets: [],
      collectionEnabled: true,
      coverage: {},
      hasArchivedEvidence: null,
    },
    null,
    NOW,
  );

  assert.equal(spend.priceBookMissing, true);
  assert.equal(spend.totalNanousd, 0n);
  assert.deepEqual(spend.unpricedModels, ["claude-sonnet-4-5"]);
});

// ── Rate selection ──────────────────────────────────────────────────────────

test("the rate in force is the latest one effective at the instant", () => {
  const book = {
    entries: [
      entry({ effectiveFrom: 1_000, rates: rates({ input: 1n }) }),
      entry({ effectiveFrom: 2_000, rates: rates({ input: 2n }) }),
      entry({ effectiveFrom: 9_000_000_000, rates: rates({ input: 9n }) }),
    ],
  };
  assert.equal(
    selectRate(book, "claude-sonnet-4-5", 1_500).rates.inputNanousdPerMtok,
    1n,
  );
  assert.equal(
    selectRate(book, "claude-sonnet-4-5", 5_000).rates.inputNanousdPerMtok,
    2n,
  );
  assert.equal(selectRate(book, "claude-sonnet-4-5", 500), null);
});

test("an owner's rate beats the catalog at the same instant", () => {
  const book = {
    entries: [
      entry({ origin: "owner", rates: rates({ input: 7n }) }),
      entry({ origin: "catalog", rates: rates({ input: 99n }) }),
    ],
  };
  assert.equal(
    selectRate(book, "claude-sonnet-4-5", NOW).rates.inputNanousdPerMtok,
    7n,
  );
});

test("an undated alias prices its dated snapshot, and nothing else", () => {
  const book = { entries: [entry({ model: "claude-sonnet-4-5" })] };
  assert.notEqual(selectRate(book, "claude-sonnet-4-5-20250929", NOW), null);
  assert.notEqual(selectRate(book, "claude-sonnet-4-5-2025-09-29", NOW), null);
  // A prefix match would price one model at another's rate.
  assert.equal(selectRate(book, "claude-sonnet-4-5-turbo", NOW), null);
  assert.equal(
    selectRate({ entries: [entry({ model: "gpt-4" })] }, "gpt-4o", NOW),
    null,
  );
});

test("a conditional row never prices a bare token total", () => {
  // A row that applies only to one provider, one tier, or one context band
  // says nothing about turns that recorded none of those.
  const book = { entries: [entry({ conditioned: true })] };
  assert.equal(selectRate(book, "claude-sonnet-4-5", NOW), null);
});

// ── Money past 2^53 ─────────────────────────────────────────────────────────

test("spend past 2^53 nanoUSD accumulates exactly", () => {
  // 2^53 nanoUSD is 9,007,199,254,740,992, about $9.01 million. The rate
  // here is one nanoUSD per million tokens, chosen so the cost of a row is
  // its output token count exactly and the assertion can be read without
  // arithmetic. Each agent lands one nanoUSD above 2^53, which is the first
  // integer a JavaScript number cannot hold.
  const cheap = {
    entries: [
      entry({
        rates: rates({
          cacheRead: 0n,
          cacheWrite5m: 0n,
          input: 0n,
          output: 1_000_000n,
        }),
      }),
    ],
  };
  const overflowing = () =>
    modelUsage({
      usage: usage({
        inputTokens: known(0),
        outputTokens: known("9007199254740993"),
      }),
    });

  const spend = priceUsageSeries(
    {
      agents: [
        agent({ agentPubkey: "aa".repeat(32), models: [overflowing()] }),
        agent({ agentPubkey: "bb".repeat(32), models: [overflowing()] }),
      ],
      buckets: [],
      collectionEnabled: true,
      coverage: {},
      hasArchivedEvidence: null,
    },
    cheap,
    NOW,
  );

  assert.equal(spend.agents[0].costNanousd, 9_007_199_254_740_993n);
  assert.equal(spend.totalNanousd, 18_014_398_509_481_986n);
  // What a JavaScript number would have produced instead, to the cent.
  assert.equal(formatNanousd(spend.totalNanousd), "$18,014,398.51");
  assert.notEqual(
    spend.totalNanousd,
    BigInt(Number(9_007_199_254_740_993n) + Number(9_007_199_254_740_993n)),
  );
});

// ── Period boundaries ───────────────────────────────────────────────────────

test("a window is one boundary per civil day, plus the one that closes it", () => {
  const boundaries = localMidnightBoundaries(7, new Date(2026, 6, 15, 13, 45));
  assert.equal(boundaries.length, 8);
  for (let index = 1; index < boundaries.length; index += 1) {
    assert.ok(
      boundaries[index] > boundaries[index - 1],
      "boundaries must be strictly increasing",
    );
    const interval = boundaries[index] - boundaries[index - 1];
    // The Rust validator refuses anything wider than 48 hours.
    assert.ok(interval > 0 && interval <= 48 * 3600, `interval ${interval}`);
  }
  for (const boundary of boundaries) {
    const at = new Date(boundary * 1000);
    assert.equal(at.getHours(), 0, "every boundary is a local midnight");
    assert.equal(at.getMinutes(), 0);
    assert.equal(at.getSeconds(), 0);
  }
  // The last boundary closes today, so today's own work is inside the window.
  assert.equal(new Date(boundaries[7] * 1000).getDate(), 16);
});

test("a one-day window is two boundaries, the smallest request that is valid", () => {
  const boundaries = localMidnightBoundaries(1, new Date(2026, 0, 1, 9, 0));
  assert.equal(boundaries.length, 2);
  assert.equal(new Date(boundaries[0] * 1000).getDate(), 1);
  assert.equal(new Date(boundaries[1] * 1000).getDate(), 2);
});

test("a window crossing a month end keeps walking civil days", () => {
  const boundaries = localMidnightBoundaries(3, new Date(2026, 2, 2, 23, 30));
  assert.deepEqual(
    boundaries.map((boundary) => new Date(boundary * 1000).getDate()),
    [28, 1, 2, 3],
  );
});
