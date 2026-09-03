// desktop/src/features/onboarding/ui/new/screens/ownedCommunities.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { ownedCommunityRows } from "./OwnedCommunitiesScreen.tsx";

test("only communities that can actually be reconnected are listed", () => {
  const rows = ownedCommunityRows([
    { id: "live", name: "North Star", normalized_host: "north-star.example" },
    {
      id: "archived",
      name: "Old Thing",
      normalized_host: "old.example",
      archived_at: "2026-01-01T00:00:00Z",
    },
    // No host, so there is no address to connect to. A row for it would be a
    // door that does not open.
    { id: "hostless", name: "Nowhere" },
  ]);

  assert.deepEqual(rows, [
    {
      key: "live",
      name: "North Star",
      host: "north-star.example",
      relayUrl: "wss://north-star.example",
    },
  ]);
});

test("a community with no name falls back to its address, never to nothing", () => {
  const [row] = ownedCommunityRows([
    { slug: "bee-lab", normalized_host: "bee-lab.example" },
  ]);
  assert.equal(row.name, "bee-lab");
  assert.equal(row.key, "bee-lab.example");

  const [unnamed] = ownedCommunityRows([{ normalized_host: "anon.example" }]);
  assert.equal(unnamed.name, "Hosted community");
});
