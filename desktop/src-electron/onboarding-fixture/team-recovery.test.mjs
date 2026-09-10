import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  recoveryScope,
  validateFixtureTeamRecovery,
} from "./team-recovery.mjs";

const secret = Uint8Array.from({ length: 32 }, (_, index) =>
  index === 31 ? 1 : 0,
);
const owner = getPublicKey(secret);
const directory = "/private/tmp/colony-onboarding-joined-fixture";
const profile = createHash("sha256")
  .update(directory)
  .digest("hex")
  .slice(0, 16);
const account = {
  ownerPubkey: owner,
  relayUrl: `wss://horizon-labs.onboarding-${profile}.invalid`,
  suggestion: { requestId: "fixture-send" },
};

function fixture() {
  const { teamId } = recoveryScope(directory, account);
  const content = {
    name: "Company Coordination",
    description: "Owner's existing description",
    instructions: "Keep the existing review policy",
    lead_persona_id: "builtin:fizz",
    persona_ids: ["builtin:fizz"],
  };
  const team = finalizeEvent(
    {
      kind: 30176,
      created_at: 2_000_000_000,
      tags: [["d", teamId]],
      content: JSON.stringify({
        ...content,
        persona_ids: [...content.persona_ids, "approved-worker"],
      }),
    },
    secret,
  );
  return {
    account,
    loss: {
      teamId,
      originalContent: content,
      originalEventId: "original",
      nativePendingSync: 0,
      relayRowsRemoved: 1,
      ownerTeamHeadsAfterLoss: 0,
    },
    task: { owningTeamId: teamId },
    traces: [
      {
        ownerPubkey: owner,
        relayUrl: account.relayUrl,
        sendId: account.suggestion.requestId,
        initialMissing: true,
        submittedEventId: team.id,
        verifiedEventId: team.id,
      },
    ],
    teams: [team],
    // These signed-reader projections intentionally carry an older action
    // timestamp: source ordering comes from the scoped before-sign trace.
    evidence: {
      taskRequests: [
        {
          action: { id: "signed-action", created_at: 1 },
          receipts: [
            {
              id: "signed-receipt",
              tags: [["company-receipt", "1", "request", "key", "applied"]],
            },
          ],
        },
      ],
    },
  };
}

test("recovery requires scoped native absence and genuine restored Team while preserving owner content", () => {
  const result = validateFixtureTeamRecovery(fixture());
  assert.equal(result.status, "recovered-before-task");
  assert.equal(result.restoredEventId, result.trace.verifiedEventId);
  assert.equal(result.taskReceiptId, "signed-receipt");
});

test("missing, wrong-scope, background-masked and mismatched native readiness cannot pass", () => {
  for (const alter of [
    (value) => {
      value.traces = [];
    },
    (value) => {
      value.traces[0].sendId = "another-job";
    },
    (value) => {
      value.traces[0].ownerPubkey = "f".repeat(64);
    },
    (value) => {
      value.traces[0].relayUrl = "wss://another.invalid";
    },
    (value) => {
      value.traces[0].initialMissing = false;
    },
    (value) => {
      value.traces[0].submittedEventId = null;
    },
    (value) => {
      value.traces[0].verifiedEventId = "f".repeat(64);
    },
    (value) => {
      value.evidence.taskRequests[0].receipts[0].tags[0][4] = "conflict";
    },
    (value) => {
      value.task.owningTeamId = "different-team";
    },
  ]) {
    const value = fixture();
    alter(value);
    assert.throws(() => validateFixtureTeamRecovery(value));
  }
});

test("a tampered signature or changed owner instructions cannot claim successful restoration", () => {
  const tampered = fixture();
  tampered.teams[0] = { ...tampered.teams[0], content: "{}" };
  assert.throws(() => validateFixtureTeamRecovery(tampered));
  const changed = fixture();
  const content = JSON.parse(changed.teams[0].content);
  changed.teams[0] = finalizeEvent(
    {
      kind: 30176,
      created_at: 2_000_000_001,
      tags: changed.teams[0].tags,
      content: JSON.stringify({
        ...content,
        instructions: "Discard owner policy",
      }),
    },
    secret,
  );
  changed.traces[0].submittedEventId = changed.teams[0].id;
  changed.traces[0].verifiedEventId = changed.teams[0].id;
  assert.throws(
    () => validateFixtureTeamRecovery(changed),
    /preserves instructions/,
  );
});

test("physical loss scope refuses foreign profiles, owners and noncanonical relays", () => {
  for (const [candidate, altered] of [
    ["/private/tmp/not-the-fixture", account],
    [directory, { ...account, relayUrl: "wss://production.example" }],
    [directory, { ...account, relayUrl: `${account.relayUrl}/` }],
    [directory, { ...account, ownerPubkey: `${owner}\n` }],
  ])
    assert.throws(() => recoveryScope(candidate, altered));
});
