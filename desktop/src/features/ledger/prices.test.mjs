import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_PRICE, isDollarAmount, priceProblem } from "./prices.ts";

function price(overrides = {}) {
  return {
    ...EMPTY_PRICE,
    model: "claude-sonnet-4-5",
    inputPerMtok: "3",
    cacheReadPerMtok: "0.30",
    cacheWrite5mPerMtok: "3.75",
    cacheWrite1hPerMtok: "6",
    outputPerMtok: "15",
    ...overrides,
  };
}

test("a complete price has no problem", () => {
  assert.equal(priceProblem(price()), null);
});

test("the form starts blank, because zero is a real rate", () => {
  // Pre-filling 0 would let someone publish a free price by not noticing.
  assert.equal(EMPTY_PRICE.inputPerMtok, "");
  assert.equal(EMPTY_PRICE.outputPerMtok, "");
  assert.match(priceProblem(EMPTY_PRICE), /Name the model/);
});

test("every rate is required, and zero is accepted when meant", () => {
  assert.match(priceProblem(price({ cacheReadPerMtok: "" })), /Cache read/);
  assert.equal(priceProblem(price({ cacheReadPerMtok: "0" })), null);
});

test("a rate must be a plain dollar amount", () => {
  for (const bad of ["$3", "3 USD", "-1", "1.2.3", "3e5", "abc"]) {
    assert.match(
      priceProblem(price({ inputPerMtok: bad })),
      /plain dollar amount/,
      `${bad} must be refused`,
    );
  }
});

test("sub-nanoUSD precision is refused at the form too", () => {
  // Ten decimal places is finer than one nanoUSD.
  assert.equal(isDollarAmount("0.000000001"), true);
  assert.equal(isDollarAmount("0.0000000001"), false);
});

test("an unreadable effective date is caught", () => {
  assert.match(
    priceProblem(price({ effectiveFrom: "last tuesday" })),
    /cannot be read/,
  );
  assert.equal(
    priceProblem(price({ effectiveFrom: "2026-08-01T00:00:00Z" })),
    null,
  );
  assert.equal(priceProblem(price({ effectiveFrom: null })), null);
});
