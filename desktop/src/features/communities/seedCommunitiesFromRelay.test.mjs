/**
 * Unit tests for mergeDiscoveredCommunities - the pure merge behind community
 * discovery. Covers acceptance items 1 and 2 of the discovery-desktop ticket.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeDiscoveredCommunities } from "./seedCommunitiesFromRelay.ts";

const STORED_A = {
  id: "stored-a",
  name: "alpha",
  relayUrl: "wss://alpha.colony.example",
  addedAt: "2024-01-01T00:00:00.000Z",
};
const STORED_B = {
  id: "stored-b",
  name: "bravo",
  relayUrl: "wss://bravo.colony.example",
  addedAt: "2024-01-02T00:00:00.000Z",
};

const OPTIONS = {
  now: "2026-09-04T00:00:00.000Z",
  makeId: () => "generated-id",
};

function relayEntry(overrides) {
  return {
    id: "relay-c",
    name: "charlie",
    slug: "charlie",
    normalized_host: "charlie.colony.example",
    owner_pubkey: "f".repeat(64),
    role: "member",
    created_at: "2026-09-03T00:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

describe("mergeDiscoveredCommunities", () => {
  it("appends a community the relay reports and the rail is missing", () => {
    const stored = [STORED_A, STORED_B];
    const result = mergeDiscoveredCommunities(
      stored,
      { owner_pubkey: "a".repeat(64), communities: [relayEntry()] },
      OPTIONS,
    );

    // Acceptance 1: three entries, the original two first and untouched.
    assert.equal(result.communities.length, 3);
    assert.deepEqual(result.communities[0], STORED_A);
    assert.deepEqual(result.communities[1], STORED_B);
    assert.deepEqual(result.communities[2], {
      id: "relay-c",
      name: "charlie",
      relayUrl: "wss://charlie.colony.example",
      addedAt: OPTIONS.now,
    });
    assert.deepEqual(result.added, [result.communities[2]]);
    // The input list is never mutated, so the caller's active selection and
    // ordering cannot move underneath it.
    assert.deepEqual(stored, [STORED_A, STORED_B]);
  });

  it("keeps the relay's order when it reports several new communities", () => {
    const result = mergeDiscoveredCommunities(
      [STORED_A],
      {
        communities: [
          relayEntry({
            id: "relay-c",
            slug: "charlie",
            normalized_host: "charlie.colony.example",
          }),
          relayEntry({
            id: "relay-d",
            slug: "delta",
            normalized_host: "delta.colony.example",
          }),
        ],
      },
      OPTIONS,
    );

    assert.deepEqual(
      result.communities.map((community) => community.name),
      ["alpha", "charlie", "delta"],
    );
  });

  it("ignores entries already stored, by relay URL or by id", () => {
    const storedByHost = [STORED_A];
    const byHost = mergeDiscoveredCommunities(
      storedByHost,
      {
        communities: [
          relayEntry({
            id: "different-id",
            slug: "renamed-alpha",
            normalized_host: "alpha.colony.example",
          }),
        ],
      },
      OPTIONS,
    );
    // Same relay, different id and slug: the stored name and id both survive.
    assert.equal(byHost.communities, storedByHost);
    assert.deepEqual(byHost.communities, [STORED_A]);
    assert.deepEqual(byHost.added, []);

    const byId = mergeDiscoveredCommunities(
      [STORED_A],
      {
        communities: [
          relayEntry({
            id: "stored-a",
            slug: "alpha-moved",
            normalized_host: "alpha-moved.colony.example",
          }),
        ],
      },
      OPTIONS,
    );
    assert.deepEqual(byId.communities, [STORED_A]);
    assert.deepEqual(byId.added, []);
  });

  it("ignores archived communities", () => {
    const result = mergeDiscoveredCommunities(
      [STORED_A],
      {
        communities: [relayEntry({ archived_at: "2026-08-01T00:00:00.000Z" })],
      },
      OPTIONS,
    );

    assert.deepEqual(result.communities, [STORED_A]);
    assert.deepEqual(result.added, []);
  });

  it("ignores entries with no host or no name", () => {
    const result = mergeDiscoveredCommunities(
      [STORED_A],
      {
        communities: [
          relayEntry({ normalized_host: "  " }),
          relayEntry({
            id: "relay-e",
            slug: "",
            name: "",
            normalized_host: "echo.colony.example",
          }),
        ],
      },
      OPTIONS,
    );

    assert.deepEqual(result.communities, [STORED_A]);
    assert.deepEqual(result.added, []);
  });

  it("falls back to a generated id when the relay omits one", () => {
    const result = mergeDiscoveredCommunities(
      [],
      { communities: [relayEntry({ id: undefined })] },
      OPTIONS,
    );

    assert.equal(result.communities[0].id, "generated-id");
  });

  it("leaves the stored list untouched for an empty, missing, or failed response", () => {
    const stored = [STORED_A, STORED_B];

    // Acceptance 2: a 404 or a network error reaches the merge as no response
    // at all, and the rail must come out byte-identical, same array reference.
    for (const response of [
      null,
      undefined,
      {},
      { communities: [] },
      { communities: "not-an-array" },
    ]) {
      const result = mergeDiscoveredCommunities(stored, response, OPTIONS);
      assert.equal(result.communities, stored);
      assert.deepEqual(result.added, []);
    }
  });
});
