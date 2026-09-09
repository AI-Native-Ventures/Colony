import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  createFirstJobTeamApproval,
  isFirstJobTeamApprovalAttempt,
} from "./firstJobTeamApproval.ts";

const key = new Uint8Array(32).fill(17);
const scope = {
  ownerPubkey: getPublicKey(key),
  relayUrl: "wss://business.example",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "job-1",
};
const proposal = {
  scout: { name: "Scout", pubkey: "c".repeat(64) },
  worker: {
    name: "Sarah",
    role: "Content & Campaign Specialist",
    pubkey: null,
  },
  action: {
    requestId: "b7ae7f70-33da-4c1a-9508-6222aac17372",
    definition: {
      displayName: "Sarah",
      systemPrompt: "Draft the work for review.",
      behavior: { respondTo: "owner-only", parallelism: 1 },
    },
    runOn: { type: "local" },
    preparation: {
      mode: "first-job-worker",
      ownerPubkey: scope.ownerPubkey,
      communityRelayUrl: scope.relayUrl,
      channelId: scope.channelId,
      leaderPubkey: "c".repeat(64),
      roleId: "content-campaign-specialist",
      roleTitle: "Content & Campaign Specialist",
    },
  },
};
const brief = "Draft five captions for my review.";
const team = {
  scoutPubkey: proposal.scout.pubkey,
  workerPubkey: "d".repeat(64),
};

function fixture() {
  let saved = null;
  let queue = Promise.resolve();
  let current = true;
  const calls = [];
  const deps = {
    store: {
      read: () => (saved ? structuredClone(saved) : null),
      write: (_scope, value) => {
        assert.ok(isFirstJobTeamApprovalAttempt(value));
        saved = structuredClone(value);
      },
      withLock: (_scope, work) => {
        const result = queue.then(work);
        queue = result.catch(() => {});
        return result;
      },
    },
    assertCurrent: async (actual) => {
      assert.deepEqual(actual, scope);
      if (!current) throw new Error("Account changed");
    },
    verifySetup: async () => {
      calls.push("verified-root");
    },
    validateProposal: async () => {
      calls.push("validate-proposal");
    },
    sign: async ({ createdAt, ...input }) =>
      finalizeEvent({ ...input, created_at: createdAt }, key),
    publish: async (_scope, event) => {
      calls.push(["publish", event.id]);
    },
    execute: async () => {
      calls.push("create-worker");
      return { status: "applied", agentPubkey: team.workerPubkey };
    },
    validateTeam: async (_scope, actual) => {
      assert.deepEqual(actual, team);
      calls.push("validate-team");
    },
    now: () => 1_800_000_000_000,
  };
  return {
    deps,
    calls,
    run: createFirstJobTeamApproval(deps),
    read: () => saved,
    set: (value) => {
      saved = value;
    },
    stale: () => {
      current = false;
    },
  };
}

test("constructing the controller never signs, creates, starts or publishes", () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.equal(f.read(), null);
});

test("owner approval reaches the relay before one native worker is created", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(scope, brief, proposal), team);
  assert.ok(
    f.calls.findIndex((c) => Array.isArray(c)) <
      f.calls.indexOf("create-worker"),
  );
  assert.equal(f.read().receiptAcknowledged, true);
  assert.equal(f.read().approval.pubkey, scope.ownerPubkey);
  assert.deepEqual(
    JSON.parse(f.read().approval.tags.at(-1)[1]).proposal.action,
    proposal.action,
  );
});

test("two concurrent clicks and relaunch reuse one creation and exact signed messages", async () => {
  const f = fixture();
  await Promise.all([
    f.run(scope, brief, proposal),
    f.run(scope, brief, proposal),
  ]);
  const first = structuredClone(f.read());
  await createFirstJobTeamApproval(f.deps)(scope, brief);
  assert.equal(f.calls.filter((c) => c === "create-worker").length, 1);
  assert.equal(f.calls.filter(Array.isArray).length, 2);
  assert.deepEqual(f.read(), first);
});

test("lost approval acknowledgement persists the same signed event and never creates early", async () => {
  const f = fixture();
  const publish = f.deps.publish;
  f.deps.publish = async () => {
    throw new Error("No acknowledgement");
  };
  await assert.rejects(f.run(scope, brief, proposal), /No acknowledgement/);
  const id = f.read().approval.id;
  assert.equal(f.calls.includes("create-worker"), false);
  f.deps.publish = publish;
  await f.run(scope, brief);
  assert.equal(f.read().approval.id, id);
});

test("native partial creation retries the same approved request and changed briefs are refused", async () => {
  const f = fixture();
  const execute = f.deps.execute;
  f.deps.execute = async () => ({
    status: "failed",
    safeMessage: "Membership pending",
  });
  await assert.rejects(f.run(scope, brief, proposal), /Membership pending/);
  const approved = structuredClone(f.read().proposal.action);
  await assert.rejects(
    f.run(scope, "A different job", proposal),
    /approved brief/,
  );
  f.deps.execute = async (action) => {
    assert.deepEqual(action, approved);
    return execute(action);
  };
  await f.run(scope, brief);
});

test("scope changing during acknowledgement stops before native mutation", async () => {
  const f = fixture();
  f.deps.publish = async () => {
    f.stale();
  };
  await assert.rejects(f.run(scope, brief, proposal), /Account changed/);
  assert.equal(f.calls.includes("create-worker"), false);
});

test("tampering with approved action or unsigned result does not select another worker", async () => {
  for (const tamper of [
    (a) => {
      a.proposal.action.definition.systemPrompt = "Unexpected instructions";
    },
    (a) => {
      a.team.workerPubkey = "e".repeat(64);
      a.receipt = null;
      a.receiptAcknowledged = false;
    },
  ]) {
    const f = fixture();
    await f.run(scope, brief, proposal);
    tamper(f.read());
    await assert.rejects(f.run(scope, brief), /verified|does not match/);
  }
});

test("an existing approved worker needs no native creation", async () => {
  const f = fixture();
  const existing = structuredClone(proposal);
  existing.worker.pubkey = team.workerPubkey;
  existing.action = null;
  await f.run(scope, brief, existing);
  assert.equal(f.calls.includes("create-worker"), false);
});

test("stored child result cannot exist before acknowledged owner approval", () => {
  assert.equal(
    isFirstJobTeamApprovalAttempt({
      content: brief,
      proposal,
      approval: null,
      approvalAcknowledged: false,
      team,
      receipt: null,
      receiptAcknowledged: false,
    }),
    false,
  );
});
