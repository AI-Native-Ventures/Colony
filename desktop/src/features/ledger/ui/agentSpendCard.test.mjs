import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const componentSource = readFileSync(
  new URL("./AgentSpendCard.tsx", import.meta.url),
  "utf8",
);

/**
 * The card's money-safety contract, pinned the way the sidebar credits
 * balance pins its own: by source. The figures this card renders are
 * estimates from archived turn metrics, and the one thing that would make
 * them dangerous is dressing an unknown up as a number.
 */

test("a read that failed or is still loading never renders as a figure", () => {
  // $0.00 is the most reassuring way to be wrong about money, so a failed
  // read has to say "Unknown" and a pending one has to show a skeleton.
  assert.match(componentSource, /<Figure>Unknown<\/Figure>/);
  assert.match(componentSource, /aria-busy="true"/);
});

test("a missing price book is named, not read as a zero floor", () => {
  // When no book exists every model is unpriced, so the floor label would
  // produce "at least $0.00": an absence dressed up as a number. The branch
  // has to come before the figure for the same reason.
  assert.match(componentSource, /spend\.priceBookMissing \?/);
  assert.match(componentSource, /<Figure>Not priced<\/Figure>/);
});

test("every figure uses the ledger's one formatter and aligns", () => {
  assert.match(componentSource, /formatNanousd/);
  assert.doesNotMatch(componentSource, /formatNanousdAsUsd/);
  assert.match(componentSource, /tabular-nums/);
});
