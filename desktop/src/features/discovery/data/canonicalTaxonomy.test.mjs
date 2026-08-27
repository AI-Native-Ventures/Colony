import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BUSINESS_TAXONOMY } from "./businessTaxonomy/index.ts";

const CANONICAL_PATH = new URL(
  "../../../../../crates/buzz-core/assets/discovery/business_taxonomy.json",
  import.meta.url,
);

test("the desktop taxonomy loads the canonical shared asset verbatim", () => {
  const canonical = JSON.parse(readFileSync(CANONICAL_PATH, "utf8"));
  assert.deepEqual(BUSINESS_TAXONOMY, canonical);
});

test("canonical taxonomy shape stays bounded, unique, and strict", () => {
  assert.equal(BUSINESS_TAXONOMY.length, 34);
  const verticalCount = BUSINESS_TAXONOMY.reduce(
    (total, industry) => total + industry.verticals.length,
    0,
  );
  assert.equal(verticalCount, 531);

  const idRe = /^[a-z0-9-]+$/;
  const seenIndustries = new Set();
  const seenVerticalPairs = new Set();
  for (const industry of BUSINESS_TAXONOMY) {
    assert.ok(idRe.test(industry.id), `industry id ${industry.id}`);
    assert.ok(industry.label.trim().length > 0);
    assert.ok(!seenIndustries.has(industry.id));
    seenIndustries.add(industry.id);
    for (const vertical of industry.verticals) {
      assert.ok(idRe.test(vertical.id), `vertical id ${vertical.id}`);
      assert.ok(!vertical.id.includes("/"), "slash is the composite separator");
      assert.ok(vertical.label.trim().length > 0);
      // Vertical slugs repeat across industries; the (industry, vertical)
      // pair must stay unique so composite mention IDs stay unambiguous.
      const pair = `${industry.id}/${vertical.id}`;
      assert.ok(!seenVerticalPairs.has(pair), `duplicate pair ${pair}`);
      seenVerticalPairs.add(pair);
    }
  }
});
