import assert from "node:assert/strict";
import test from "node:test";

import { selectUnassignedAgents } from "./unassignedAgents.ts";

function agent(pubkey, relayUrl) {
  return { pubkey, name: pubkey, relayUrl };
}

test("an agent with no relay pin is shared across every community", () => {
  const agents = [
    agent("a", ""),
    agent("b", "wss://one.example.com"),
    agent("c", ""),
  ];
  assert.deepEqual(
    selectUnassignedAgents(agents).map((found) => found.pubkey),
    ["a", "c"],
  );
});

test("whitespace is a blank pin, not a community", () => {
  assert.deepEqual(
    selectUnassignedAgents([agent("a", "   ")]).map((found) => found.pubkey),
    ["a"],
  );
});

test("a fully assigned roster has nothing to offer", () => {
  assert.deepEqual(
    selectUnassignedAgents([
      agent("a", "wss://one.example.com"),
      agent("b", "wss://two.example.com"),
    ]),
    [],
  );
});
