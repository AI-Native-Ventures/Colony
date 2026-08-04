import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  budgetDTag,
  formatNanousd,
  parseBudget,
  parseCorrectionBook,
  parsePriceBook,
  parseRulebook,
} from "./contracts.ts";

const RELAY_SECRET = generateSecretKey();
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const IMPOSTOR_SECRET = generateSecretKey();

const RATES = {
  inputNanousdPerToken: 3000,
  cacheReadNanousdPerToken: 300,
  cacheWrite5mNanousdPerToken: 3750,
  cacheWrite1hNanousdPerToken: 6000,
  outputNanousdPerToken: 15000,
};

const ASSIGNMENT = {
  companyId: "horizon-labs",
  costCentreId: "web-delivery",
  owningTeamId: "web-team",
  commercialPurpose: "clientDelivery",
  clientOrganizationId: "tennant-group",
  taskId: null,
};

function head(kind, dTag, content, secret = RELAY_SECRET) {
  return finalizeEvent(
    {
      kind,
      created_at: 1_785_628_800,
      tags: [["d", dTag]],
      content: JSON.stringify(content),
    },
    secret,
  );
}

function priceBookEvent(entries, secret = RELAY_SECRET) {
  return head(30184, "pricebook", { entries }, secret);
}

const ENTRY = {
  model: "claude-sonnet-4-5",
  effectiveFrom: 1_785_628_800,
  rates: RATES,
  note: "launch",
};

test("a price book round-trips with money as bigint", () => {
  const book = parsePriceBook(priceBookEvent([ENTRY]), RELAY_PUBKEY);
  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0].model, "claude-sonnet-4-5");
  assert.equal(book.entries[0].rates.inputNanousdPerToken, 3000n);
  assert.equal(typeof book.entries[0].rates.outputNanousdPerToken, "bigint");
  assert.equal(book.entries[0].note, "launch");
});

test("a book signed by anyone but the relay is refused", () => {
  // A client never signs a book. One that verifies under another key is a
  // forgery or a bug, and either way its numbers mean nothing.
  const forged = JSON.parse(
    JSON.stringify(priceBookEvent([ENTRY], IMPOSTOR_SECRET)),
  );
  assert.throws(
    () => parsePriceBook(forged, RELAY_PUBKEY),
    /not authored by the tenant relay/,
  );
});

test("a tampered book fails signature verification", () => {
  const event = priceBookEvent([ENTRY]);
  // Round-trip through JSON, which is how an event actually arrives from a
  // relay. `finalizeEvent` stamps a `Symbol(verified)` cache flag and object
  // spread copies symbols, so a tampered event built by spreading a finalized
  // one carries a stale "already verified" marker and passes. That would be a
  // test proving nothing about the check it names.
  const tampered = JSON.parse(
    JSON.stringify({
      ...event,
      content: JSON.stringify({
        entries: [{ ...ENTRY, rates: { ...RATES, inputNanousdPerToken: 1 } }],
      }),
    }),
  );
  assert.throws(
    () => parsePriceBook(tampered, RELAY_PUBKEY),
    /signature does not verify/,
  );
});

test("an unknown field is refused rather than ignored", () => {
  // Rust refuses unknown fields on these records. A reader that quietly
  // accepted one would present a number the relay would never have written.
  const event = priceBookEvent([{ ...ENTRY, surprise: true }]);
  assert.throws(
    () => parsePriceBook(event, RELAY_PUBKEY),
    /unknown field surprise/,
  );
});

test("an amount past exact integer range is refused, never rounded", () => {
  // 2^53 nanoUSD is about $9,007, which a real company passes inside a year.
  // JSON parsing has already rounded such a value, so showing it would be
  // showing an approximation as money.
  // Written through JSON rather than as a literal, which is both how it
  // arrives from a relay and the only way to express a value the linter
  // correctly refuses to let anyone type by hand.
  const unsafe = JSON.parse('{"n": 9007199254740993}').n;
  const event = priceBookEvent([
    { ...ENTRY, rates: { ...RATES, inputNanousdPerToken: unsafe } },
  ]);
  assert.throws(
    () => parsePriceBook(event, RELAY_PUBKEY),
    /already approximate/,
  );
});

test("a nanoUSD amount may arrive as a decimal string and stays exact", () => {
  const big = "123456789012345678";
  const event = priceBookEvent([
    { ...ENTRY, rates: { ...RATES, inputNanousdPerToken: big } },
  ]);
  const book = parsePriceBook(event, RELAY_PUBKEY);
  assert.equal(book.entries[0].rates.inputNanousdPerToken, BigInt(big));
});

test("a rulebook round-trips and refuses an unknown purpose", () => {
  const rule = {
    id: "r1",
    priority: 10,
    matchProvider: "anthropic",
    matchHarness: null,
    matchAgentPubkey: null,
    matchChannelId: null,
    matchModel: null,
    assign: ASSIGNMENT,
  };
  const book = parseRulebook(
    head(30185, "rulebook", { rules: [rule] }),
    RELAY_PUBKEY,
  );
  assert.equal(book.rules[0].id, "r1");
  assert.equal(book.rules[0].assign.commercialPurpose, "clientDelivery");

  const bad = head(30185, "rulebook", {
    rules: [{ ...rule, assign: { ...ASSIGNMENT, commercialPurpose: "vibes" } }],
  });
  assert.throws(
    () => parseRulebook(bad, RELAY_PUBKEY),
    /commercialPurpose is unknown/,
  );
});

test("a correction must reference a real event id", () => {
  const correction = {
    id: "c1",
    usageRecordEventId: "a".repeat(64),
    assign: ASSIGNMENT,
    reason: "was billable client work",
    correctedAt: 1_785_628_800,
  };
  const book = parseCorrectionBook(
    head(30186, "corrections", { corrections: [correction] }),
    RELAY_PUBKEY,
  );
  assert.equal(book.corrections[0].usageRecordEventId, "a".repeat(64));

  const bad = head(30186, "corrections", {
    corrections: [{ ...correction, usageRecordEventId: "not-an-event" }],
  });
  assert.throws(
    () => parseCorrectionBook(bad, RELAY_PUBKEY),
    /64-hex event id/,
  );
});

test("a correction without a reason is refused", () => {
  // An unexplained restatement is not an audit trail.
  const bad = head(30186, "corrections", {
    corrections: [
      {
        id: "c1",
        usageRecordEventId: "a".repeat(64),
        assign: ASSIGNMENT,
        reason: "   ",
        correctedAt: 1,
      },
    ],
  });
  assert.throws(() => parseCorrectionBook(bad, RELAY_PUBKEY), /reason must be/);
});

test("a budget is addressed by its own cost centre and period", () => {
  const budget = {
    costCentreId: "web-delivery",
    period: "2026-08",
    amountNanousd: 500_000_000_000,
  };
  const event = head(30187, budgetDTag("web-delivery", "2026-08"), budget);
  const parsed = parseBudget(event, RELAY_PUBKEY);
  assert.equal(parsed.amountNanousd, 500000000000n);

  // A budget filed under someone else's coordinate is refused: the d tag is
  // how it is addressed, so a mismatch means it is not the budget it claims.
  const misfiled = head(30187, budgetDTag("internal-ops", "2026-08"), budget);
  assert.throws(() => parseBudget(misfiled, RELAY_PUBKEY), /exactly one d tag/);
});

test("a budget period must be a real month", () => {
  for (const period of ["2026-8", "2026-13", "2026-00", "2026-08-01"]) {
    const event = head(30187, budgetDTag("web-delivery", period), {
      costCentreId: "web-delivery",
      period,
      amountNanousd: 1,
    });
    assert.throws(
      () => parseBudget(event, RELAY_PUBKEY),
      /period must be YYYY-MM/,
    );
  }
});

test("nanoUSD formats as money without floating point", () => {
  assert.equal(formatNanousd(0n), "$0.00");
  assert.equal(formatNanousd(70_500_000n), "$0.07");
  assert.equal(formatNanousd(12_500_000_000n), "$12.50");
  assert.equal(formatNanousd(1_234_000_000_000n), "$1,234.00");
  assert.equal(formatNanousd(1_234_567_890_000_000n), "$1,234,567.89");
  // Half a cent rounds up, so a displayed total never reads lower than what
  // was actually spent.
  assert.equal(formatNanousd(5_000_000n), "$0.01");
  assert.equal(formatNanousd(4_999_999n), "$0.00");
  // Past what a double can represent exactly, and still exact.
  assert.equal(formatNanousd(90_071_992_547_409_930n), "$90,071,992.55");
});

test("a price row without an origin is treated as the owner's", () => {
  // Every row written before origins existed was owner-published, and must
  // keep beating Colony's catalog.
  const book = parsePriceBook(priceBookEvent([ENTRY]), RELAY_PUBKEY);
  assert.equal(book.entries[0].origin, "owner");
});

test("a catalog origin round-trips", () => {
  const book = parsePriceBook(
    priceBookEvent([{ ...ENTRY, origin: "catalog" }]),
    RELAY_PUBKEY,
  );
  assert.equal(book.entries[0].origin, "catalog");
});

test("an unknown origin is refused rather than assumed", () => {
  assert.throws(
    () =>
      parsePriceBook(
        priceBookEvent([{ ...ENTRY, origin: "vendor" }]),
        RELAY_PUBKEY,
      ),
    /origin is unknown/,
  );
});
