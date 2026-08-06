import assert from "node:assert/strict";
import test from "node:test";

import { validateDiscoverySearch } from "./discoverySearch.ts";

test("a bare discovery route defaults to the Leads surface", () => {
  assert.equal(validateDiscoverySearch({}).surface, "leads");
});

test("an industry deep link keeps an inferred surface", () => {
  const search = validateDiscoverySearch({ industryId: "healthcare" });
  assert.equal(search.surface, undefined);
  assert.equal(search.industryId, "healthcare");
});
