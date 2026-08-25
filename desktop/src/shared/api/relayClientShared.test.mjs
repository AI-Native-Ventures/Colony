import assert from "node:assert/strict";
import test from "node:test";

import { isRelayConnectionDegraded, sortEvents } from "./relayClientShared.ts";

function event(id, createdAt) {
  return {
    id,
    pubkey: "pubkey",
    created_at: createdAt,
    kind: 9,
    tags: [],
    content: "",
    sig: "sig",
  };
}

test("sortEvents — same-second events sort by id, order-independent", () => {
  const a = event("aaa", 100);
  const b = event("bbb", 100);
  const c = event("ccc", 101);

  const forward = sortEvents([a, b, c]).map((e) => e.id);
  const shuffled = sortEvents([c, b, a]).map((e) => e.id);

  // Stable (created_at, id) order regardless of input order, matching the
  // cache sort (sortMessages). The same-second tiebreak is id DESC because the
  // relay's canonical order is (created_at DESC, id ASC): read chronologically,
  // the smaller id is the newer event and comes last.
  assert.deepEqual(forward, ["bbb", "aaa", "ccc"]);
  assert.deepEqual(shuffled, ["bbb", "aaa", "ccc"]);
});

test("isRelayConnectionDegraded — healthy states are not degraded", () => {
  assert.equal(isRelayConnectionDegraded("idle"), false);
  assert.equal(isRelayConnectionDegraded("connecting"), false);
  assert.equal(isRelayConnectionDegraded("connected"), false);
});

test("isRelayConnectionDegraded — non-healthy states are degraded", () => {
  assert.equal(isRelayConnectionDegraded("reconnecting"), true);
  assert.equal(isRelayConnectionDegraded("stalled"), true);
  assert.equal(isRelayConnectionDegraded("disconnected"), true);
});
