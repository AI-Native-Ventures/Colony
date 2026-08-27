import assert from "node:assert/strict";
import { test } from "node:test";

import { slugCandidates, slugifyCompany } from "./workspaceSlug.ts";

test("lowercases, hyphenates, strips punctuation", () => {
  assert.equal(slugifyCompany("Rosebank Auto Care"), "rosebank-auto-care");
  assert.equal(slugifyCompany("  Café & Sons!  "), "cafe-sons");
  assert.equal(slugifyCompany("A--B__C"), "a-b-c");
});

test("trims to 63 chars without a trailing hyphen", () => {
  const long = "x".repeat(80);
  assert.equal(slugifyCompany(long).length, 63);
  const edge = `${"a".repeat(62)}-bcd`;
  assert.ok(!slugifyCompany(edge).endsWith("-"));
});

test("falls back to 'workspace' when nothing survives", () => {
  assert.equal(slugifyCompany("!!!"), "workspace");
  assert.equal(slugifyCompany(""), "workspace");
});

test("candidates: base then -2 through -9, all within 63 chars", () => {
  const list = slugCandidates("acme");
  assert.deepEqual(list.slice(0, 3), ["acme", "acme-2", "acme-3"]);
  assert.equal(list.length, 9);
  const longList = slugCandidates("y".repeat(63));
  for (const candidate of longList) {
    assert.ok(candidate.length <= 63, candidate);
  }
});
