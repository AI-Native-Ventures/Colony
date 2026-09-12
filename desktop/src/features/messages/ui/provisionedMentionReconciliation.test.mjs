import assert from "node:assert/strict";
import test from "node:test";

import { reconcileProvisionedMentionedAgents } from "./provisionedMentionReconciliation.ts";

const AVERY = "a".repeat(64);

test("cached provisioned identity is adopted when partial metadata refresh fails", async () => {
  const managedAgents = new Map();
  let adoptCalls = 0;
  const result = await reconcileProvisionedMentionedAgents({
    mentionPubkeys: [AVERY],
    managedAgentsByPubkey: managedAgents,
    preparedManagedAgents: [],
    getCachedMetadata: () => ({
      employeeHeads: new Map([
        [AVERY, {
          pubkey: AVERY,
          role: "website-manager",
          name: "Avery",
          rank: "executive",
          manager: null,
          provisioned: "website-manager",
        }],
      ]),
      managedHeads: [],
      ownerPubkeys: new Set(),
    }),
    refreshMetadata: async () => {
      throw new Error("the other role heads are temporarily unavailable");
    },
    refreshManagedAgents: async () => [
      { pubkey: AVERY, name: "Avery" },
    ],
    adopt: async () => {
      adoptCalls += 1;
      return [{ outcome: "adopted", handle: "website-manager", name: "Avery", pubkey: AVERY }];
    },
    scopeStillCurrent: () => true,
  });

  assert.equal(result, null);
  assert.equal(adoptCalls, 1);
  assert.equal(managedAgents.has(AVERY), true);
});
