import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchManagedAgentHeadEvents,
  resetManagedAgentHeadsState,
} from "./managedAgentHeads.ts";
import { relayClient } from "@/shared/api/relayClient.ts";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";

function managedHeadEvent({ createdAt = 1_000 } = {}) {
  return {
    id: "e".repeat(64),
    pubkey: OWNER,
    created_at: createdAt,
    kind: KIND_MANAGED_AGENT,
    tags: [["d", AGENT]],
    content: JSON.stringify({ name: "Scout", tier: "worker" }),
    sig: "f".repeat(128),
  };
}

test("a community switch drops an in-flight managed-agent head fetch", async () => {
  // Simulate a relay fetch that resolves after the community switches.
  // The generation check (mirroring fetchEmployeeHeads) must return []
  // rather than delivering the old community's heads into the new one.
  const events = [managedHeadEvent()];
  const originalFetchEvents = relayClient.fetchEvents.bind(relayClient);

  /** @type {(events: typeof events) => void} */
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  relayClient.fetchEvents = async () => fetchPromise;

  try {
    const fetchStarted = fetchManagedAgentHeadEvents();

    // Simulate the community switch: resetCommunityState() calls
    // resetManagedAgentHeadsState() to bump the generation.
    resetManagedAgentHeadsState();

    // The old relay resolves with the old community's events.
    resolveFetch(events);

    const result = await fetchStarted;

    // The generation check must drop the stale events: an empty array
    // is the only acceptable answer after a community switch.
    assert.equal(
      result.length,
      0,
      "an in-flight fetch must return [] after a community switch, not the old community's events",
    );
  } finally {
    relayClient.fetchEvents = originalFetchEvents;
  }
});
