import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FALLBACK_MODELS,
  chainOrderWarning,
  fallbackOptionsForSlot,
  isFreeModelId,
  moveChainEntry,
  normalizeChain,
  remainingChainSlots,
} from "./modelChain.lib.ts";

const options = [
  { id: "", label: "Default" },
  { id: "a/one:free", label: "One" },
  { id: "b/two:free", label: "Two" },
  { id: "c/paid", label: "Paid" },
];

test("the free badge follows the :free variant suffix, not the word", () => {
  assert.equal(isFreeModelId("cohere/north-mini-code:free"), true);
  assert.equal(isFreeModelId("  cohere/north-mini-code:FREE  "), true);
  assert.equal(isFreeModelId("vendor/free-tier-model"), false);
  assert.equal(isFreeModelId("vendor/freedom"), false);
  assert.equal(isFreeModelId(""), false);
});

test("normalization trims, drops blanks, and keeps the first of a duplicate", () => {
  assert.deepEqual(
    normalizeChain(["  a/one:free ", "", "   ", "b/two:free", "a/one:free"]),
    ["a/one:free", "b/two:free"],
  );
});

test("a chain is capped at five entries", () => {
  const seven = Array.from({ length: 7 }, (_, i) => `v/model-${i}`);
  const capped = normalizeChain(seven);
  assert.equal(capped.length, MAX_FALLBACK_MODELS);
  assert.deepEqual(capped, seven.slice(0, MAX_FALLBACK_MODELS));
  assert.equal(remainingChainSlots(capped), 0);
  assert.equal(remainingChainSlots(["v/model-0"]), 4);
});

test("moving an entry keeps every other entry's relative order", () => {
  const chain = ["a", "b", "c", "d"];
  assert.deepEqual(moveChainEntry(chain, 2, 0), ["c", "a", "b", "d"]);
  assert.deepEqual(moveChainEntry(chain, 0, 3), ["b", "c", "d", "a"]);
  // A move off either end is a no-op, not a silent reorder.
  assert.deepEqual(moveChainEntry(chain, 0, -1), chain);
  assert.deepEqual(moveChainEntry(chain, 3, 4), chain);
  assert.deepEqual(moveChainEntry(chain, 9, 0), chain);
  // The input is never mutated.
  assert.deepEqual(chain, ["a", "b", "c", "d"]);
});

test("a paid model below a free one warns, and names the paid entry", () => {
  const warning = chainOrderWarning("a/one:free", ["b/two:free", "c/paid"]);
  assert.ok(warning);
  assert.ok(warning.includes("c/paid"));
});

test("a paid model above the free ones does not warn", () => {
  assert.equal(chainOrderWarning("c/paid", ["a/one:free", "b/two:free"]), null);
  assert.equal(chainOrderWarning("a/one:free", ["b/two:free"]), null);
  assert.equal(chainOrderWarning("", []), null);
});

test("an empty primary model is skipped rather than read as paid", () => {
  assert.equal(chainOrderWarning("   ", ["a/one:free", "b/two:free"]), null);
});

test("the primary model is never offered as a fallback", () => {
  const offered = fallbackOptionsForSlot({
    chain: ["", ""],
    index: 0,
    options,
    primaryModel: " a/one:free ",
  }).map((option) => option.id);
  assert.deepEqual(offered, ["b/two:free", "c/paid"]);
});

test("ids used by other slots drop out, the slot's own value stays", () => {
  const offered = fallbackOptionsForSlot({
    chain: ["b/two:free", "c/paid"],
    index: 1,
    options,
    primaryModel: "z/primary",
  }).map((option) => option.id);
  assert.deepEqual(offered, ["a/one:free", "c/paid"]);
});
