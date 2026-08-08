import assert from "node:assert/strict";
import test from "node:test";

import { validateDiscoverySearch } from "./discoverySearch.ts";

test("a bare discovery route defaults to the Leads surface", () => {
  assert.equal(validateDiscoverySearch({}).surface, "leads");
});

test("the pipeline surface is validated at the router boundary", () => {
  assert.equal(
    validateDiscoverySearch({ surface: "pipeline" }).surface,
    "pipeline",
  );
});

test("an industry deep link keeps an inferred surface", () => {
  const search = validateDiscoverySearch({ industryId: "healthcare" });
  assert.equal(search.surface, undefined);
  assert.equal(search.industryId, "healthcare");
});

test("a leadId deep link is validated and preserved", () => {
  const search = validateDiscoverySearch({ leadId: "lead-001" });
  assert.equal(search.leadId, "lead-001");
});

test("an empty leadId is dropped at the router boundary", () => {
  const search = validateDiscoverySearch({ leadId: "" });
  assert.equal(search.leadId, undefined);
});
