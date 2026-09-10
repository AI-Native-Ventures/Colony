import assert from "node:assert/strict";
import test from "node:test";

import {
  discoveryEntityRefsKey,
  parseDiscoveryEntityTags,
} from "./discoveryEntityTags.ts";

const LEAD_ID = "6f1c9d2e-4a71-4f2b-9c3d-0b7a5e21f8ac";
const OTHER_LEAD_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

test("reads three-element and four-element discovery tags", () => {
  assert.deepEqual(
    parseDiscoveryEntityTags([
      ["discovery", "industry", "construction"],
      ["discovery", "lead", LEAD_ID, "Atlantic Plumbing"],
    ]),
    [
      { kind: "industry", id: "construction" },
      { kind: "lead", id: LEAD_ID },
    ],
  );
});

test("ignores tags that are not discovery references", () => {
  assert.deepEqual(
    parseDiscoveryEntityTags([
      ["h", "channel-id"],
      ["mention", "tyler"],
      ["discovery"],
      ["discovery", "industry"],
      ["discovery", "industry", "construction", "Construction", "extra"],
    ]),
    [],
  );
});

test("rejects unknown kinds and malformed identifiers", () => {
  assert.deepEqual(
    parseDiscoveryEntityTags([
      ["discovery", "party", "construction"],
      ["discovery", "lead", "not-a-uuid"],
      ["discovery", "vertical", "plumbing"],
      ["discovery", "vertical", "construction/plumbing"],
    ]),
    [{ kind: "vertical", id: "construction/plumbing" }],
  );
});

test("dedupes by kind plus id and keeps first-seen order", () => {
  assert.deepEqual(
    parseDiscoveryEntityTags([
      ["discovery", "lead", LEAD_ID, "Atlantic Plumbing"],
      ["discovery", "industry", "construction"],
      ["discovery", "lead", LEAD_ID, "Atlantic Plumbing (again)"],
      ["discovery", "campaign_leads", OTHER_LEAD_ID],
    ]),
    [
      { kind: "lead", id: LEAD_ID },
      { kind: "industry", id: "construction" },
      { kind: "campaign_leads", id: OTHER_LEAD_ID },
    ],
  );
});

test("caps a message at twenty references", () => {
  const tags = Array.from({ length: 25 }, (_unused, index) => [
    "discovery",
    "industry",
    `industry-${index}`,
  ]);
  const refs = parseDiscoveryEntityTags(tags);
  assert.equal(refs.length, 20);
  assert.deepEqual(refs[19], { kind: "industry", id: "industry-19" });
});

test("no tags at all resolves to no references", () => {
  assert.deepEqual(parseDiscoveryEntityTags(undefined), []);
  assert.deepEqual(parseDiscoveryEntityTags([]), []);
});

test("the cache key ignores reference order", () => {
  const forward = parseDiscoveryEntityTags([
    ["discovery", "industry", "construction"],
    ["discovery", "lead", LEAD_ID],
  ]);
  const reversed = parseDiscoveryEntityTags([
    ["discovery", "lead", LEAD_ID],
    ["discovery", "industry", "construction"],
  ]);
  assert.equal(
    discoveryEntityRefsKey(forward),
    discoveryEntityRefsKey(reversed),
  );
  assert.notEqual(discoveryEntityRefsKey(forward), discoveryEntityRefsKey([]));
});
