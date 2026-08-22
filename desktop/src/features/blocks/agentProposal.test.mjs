import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  closeAgentProposalReview,
  openAgentProposalReview,
  parseAgentProposalData,
  parseAgentProposalDecline,
  parseAgentProposalSafeAction,
  resetAgentProposalReview,
  subscribeAgentProposalReview,
} from "./agentProposal.ts";
import {
  agentProposalExecutionKey,
  pendingAcknowledgedAgentProposalActions,
  processAgentProposalActionUntilTerminal,
  rememberAcknowledgedAgentProposalAction,
  isAuthoritativeAgentProposalReceipt,
  runAgentProposalActionOnce,
  validateAgentProposalActionContext,
} from "./useAgentProposalBroker.ts";
import { canonicalBlockJson } from "./blockActions.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function createProposal(overrides = {}) {
  return {
    mode: "create",
    requestId: REQUEST_ID,
    channelId: "channel",
    displayName: "Researcher",
    systemPrompt: "Research qualified leads.",
    ...overrides,
  };
}

function updateProposal(overrides = {}) {
  return {
    mode: "update",
    requestId: REQUEST_ID,
    channelId: "channel",
    agentName: "Researcher",
    systemPrompt: "Research and verify qualified leads.",
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    definition: {
      displayName: "Researcher",
      systemPrompt: "Research qualified leads.",
      runtime: "codex",
      behavior: {
        respondTo: "owner-only",
        parallelism: 2,
      },
    },
    runOn: { type: "local" },
    ...overrides,
  };
}

test("agent proposal data is strict and tied to the Block instance UUID", () => {
  assert.deepEqual(
    parseAgentProposalData(createProposal(), REQUEST_ID),
    createProposal(),
  );
  assert.equal(
    parseAgentProposalData(
      createProposal({ requestId: "22222222-2222-4222-8222-222222222222" }),
      REQUEST_ID,
    ),
    null,
  );
  assert.equal(
    parseAgentProposalData(
      createProposal({ envVars: { TOKEN: "secret" } }),
      REQUEST_ID,
    ),
    null,
  );
  assert.equal(
    parseAgentProposalData(
      updateProposal({ systemPrompt: undefined }),
      REQUEST_ID,
    ),
    null,
  );
});

test("safe actions reject secrets, provider config, unknown keys, and request mismatch", () => {
  const proposal = parseAgentProposalData(createProposal(), REQUEST_ID);
  assert.ok(proposal);
  for (const unsafe of [
    action({ envVars: { TOKEN: "secret" } }),
    action({
      definition: {
        ...action().definition,
        privateKey: "secret",
      },
    }),
    action({
      runOn: { type: "provider", id: "blox", config: { token: "secret" } },
    }),
    action({ requestId: "22222222-2222-4222-8222-222222222222" }),
  ]) {
    assert.equal(parseAgentProposalSafeAction(unsafe, proposal), null);
  }
});

test("create rejects an ID and update requires the one reviewed editable target", () => {
  const create = parseAgentProposalData(createProposal(), REQUEST_ID);
  const update = parseAgentProposalData(updateProposal(), REQUEST_ID);
  assert.ok(create);
  assert.ok(update);
  assert.equal(
    parseAgentProposalSafeAction(
      action({ definition: { ...action().definition, id: "definition-a" } }),
      create,
    ),
    null,
  );
  assert.equal(
    parseAgentProposalSafeAction(action(), update, "definition-a"),
    null,
  );
  assert.equal(
    parseAgentProposalSafeAction(
      action({ definition: { ...action().definition, id: "definition-b" } }),
      update,
      "definition-a",
    ),
    null,
  );
  assert.ok(
    parseAgentProposalSafeAction(
      action({ definition: { ...action().definition, id: "definition-a" } }),
      update,
      "definition-a",
    ),
  );
});

test("avatars are uploaded HTTP(S) URLs and provider config stays outside the action", () => {
  const proposal = parseAgentProposalData(createProposal(), REQUEST_ID);
  assert.ok(proposal);
  assert.equal(
    parseAgentProposalSafeAction(
      action({
        definition: {
          ...action().definition,
          avatarUrl: "data:image/png;base64,AAAA",
        },
      }),
      proposal,
    ),
    null,
  );
  assert.ok(
    parseAgentProposalSafeAction(
      action({
        definition: {
          ...action().definition,
          avatarUrl: "https://media.example/avatar.png",
        },
        runOn: { type: "provider", id: "blox" },
      }),
      proposal,
    ),
  );
});

test("decline matches the manifest's optional bounded reason", () => {
  const proposal = parseAgentProposalData(createProposal(), REQUEST_ID);
  assert.ok(proposal);
  assert.deepEqual(parseAgentProposalDecline({}, proposal), {});
  assert.deepEqual(parseAgentProposalDecline({ reason: "Not now" }, proposal), {
    reason: "Not now",
  });
  assert.equal(
    parseAgentProposalDecline({ requestId: REQUEST_ID }, proposal),
    null,
  );
  assert.equal(
    parseAgentProposalDecline({ reason: "x".repeat(2_001) }, proposal),
    null,
  );
});

test("two persisted proposals can be reviewed, closed, and reopened independently", () => {
  const seen = [];
  const unsubscribe = subscribeAgentProposalReview((proposal) => {
    seen.push(proposal?.event.id ?? null);
  });
  const first = {
    event: { id: "a".repeat(64) },
    instanceId: REQUEST_ID,
  };
  const second = {
    event: { id: "b".repeat(64) },
    instanceId: "22222222-2222-4222-8222-222222222222",
  };
  openAgentProposalReview(first);
  openAgentProposalReview(second);
  closeAgentProposalReview();
  openAgentProposalReview(first);
  assert.deepEqual(seen, [
    null,
    "a".repeat(64),
    "b".repeat(64),
    null,
    "a".repeat(64),
  ]);
  unsubscribe();
  resetAgentProposalReview();
});

function signedProposalFixture() {
  const ownerSecret = generateSecretKey();
  const agentSecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const agentPubkey = getPublicKey(agentSecret);
  const manifestId = "b".repeat(64);
  const channelId = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
  const proposalData = createProposal({ channelId });
  const instanceEvent = finalizeEvent(
    {
      kind: 9,
      created_at: 1,
      content: "Developer proposed hiring Researcher.",
      tags: [
        ["h", channelId],
        ["p", ownerPubkey],
        ["e", manifestId, "", "block"],
        ["block", "1", "agent-proposal", manifestId, REQUEST_ID],
        ["block-attention", "1", "required"],
        ["block-data", canonicalBlockJson(proposalData)],
      ],
    },
    agentSecret,
  );
  const actionEvent = finalizeEvent(
    {
      kind: 40010,
      created_at: 2,
      content: canonicalBlockJson(action()),
      tags: [
        ["h", channelId],
        ["p", ownerPubkey],
        ["e", instanceEvent.id, "", "block-instance"],
        ["e", manifestId, "", "block-manifest"],
        [
          "block-action",
          "1",
          "agent.create",
          REQUEST_ID,
          "33333333-3333-4333-8333-333333333333",
        ],
      ],
    },
    ownerSecret,
  );
  return {
    ownerSecret,
    ownerPubkey,
    agentPubkey,
    channelId,
    instanceEvent,
    actionEvent,
  };
}

test("broker accepts only owner-signed actions from an owned signer in the shared channel", () => {
  const fixture = signedProposalFixture();
  const context = {
    ownerPubkey: fixture.ownerPubkey,
    managedAgents: [{ pubkey: fixture.agentPubkey }],
    channels: [
      {
        id: fixture.channelId,
        isMember: true,
        memberPubkeys: [fixture.agentPubkey],
      },
    ],
    personas: [],
  };
  assert.equal(
    validateAgentProposalActionContext({
      actionEvent: fixture.actionEvent,
      instanceEvent: fixture.instanceEvent,
      context,
    })?.actionId,
    "agent.create",
  );
  assert.equal(
    validateAgentProposalActionContext({
      actionEvent: fixture.actionEvent,
      instanceEvent: fixture.instanceEvent,
      context: { ...context, managedAgents: [] },
    }),
    null,
  );
  assert.equal(
    validateAgentProposalActionContext({
      actionEvent: fixture.actionEvent,
      instanceEvent: fixture.instanceEvent,
      context: {
        ...context,
        channels: [
          {
            id: fixture.channelId,
            isMember: true,
            memberPubkeys: [],
          },
        ],
      },
    }),
    null,
  );
});

test("broker single-flight survives overlapping replay and permits retry after completion", async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = runAgentProposalActionOnce(
    "owner:community:proposal",
    "action",
    async () => {
      calls += 1;
      await blocked;
      return "applied";
    },
  );
  const replay = runAgentProposalActionOnce(
    "owner:community:proposal",
    "action",
    async () => {
      calls += 1;
      return "duplicate";
    },
  );

  assert.equal(first, replay);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await replay, "applied");
  assert.equal(
    await runAgentProposalActionOnce(
      "owner:community:proposal",
      "action",
      async () => {
        calls += 1;
        return "retry";
      },
    ),
    "retry",
  );
  assert.equal(calls, 2);
});

test("broker serializes distinct actions for one proposal and separates communities", async () => {
  const proposalKey = agentProposalExecutionKey({
    ownerPubkey: "OWNER",
    communityExecutionScope: "community-a:7",
    instanceEventId: "proposal",
  });
  assert.equal(
    proposalKey,
    agentProposalExecutionKey({
      ownerPubkey: "owner",
      communityExecutionScope: "community-a:7",
      instanceEventId: "proposal",
    }),
  );
  assert.notEqual(
    proposalKey,
    agentProposalExecutionKey({
      ownerPubkey: "owner",
      communityExecutionScope: "community-b:8",
      instanceEventId: "proposal",
    }),
  );

  const order = [];
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = runAgentProposalActionOnce(
    proposalKey,
    "decline",
    async () => {
      order.push("decline:start");
      await blocked;
      order.push("decline:end");
      return "declined";
    },
    (result) => result === "declined",
  );
  const second = runAgentProposalActionOnce(proposalKey, "create", async () => {
    order.push("create:start");
    return "created";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["decline:start"]);
  release();
  assert.equal(await first, "declined");
  assert.equal(await second, null);
  assert.deepEqual(order, ["decline:start", "decline:end"]);
});

test("broker permits the next queued action after a non-resolving failure", async () => {
  const proposalKey = agentProposalExecutionKey({
    ownerPubkey: "owner",
    communityExecutionScope: "community-a:9",
    instanceEventId: "proposal",
  });
  const order = [];
  const first = runAgentProposalActionOnce(
    proposalKey,
    "failed-create",
    async () => {
      order.push("failed");
      return "failed";
    },
    () => false,
  );
  const second = runAgentProposalActionOnce(
    proposalKey,
    "retry-create",
    async () => {
      order.push("retry");
      return "created";
    },
    () => true,
  );

  assert.equal(await first, "failed");
  assert.equal(await second, "created");
  assert.deepEqual(order, ["failed", "retry"]);
});

test("broker retains locally acknowledged actions until a broker can consume them", () => {
  const event = { id: "locally-acknowledged-action" };
  rememberAcknowledgedAgentProposalAction({ event });
  assert.ok(
    pendingAcknowledgedAgentProposalActions().some(
      (item) => item.event.id === event.id,
    ),
  );
});

test("broker retries a transiently missed action until its receipt is published", async () => {
  const outcomes = ["retry", "complete"];
  const delays = [];
  let calls = 0;

  const outcome = await processAgentProposalActionUntilTerminal({
    isActive: () => true,
    operation: async () => {
      calls += 1;
      return outcomes.shift();
    },
    wait: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(outcome, "complete");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("broker retries a transient processing error but stops for an ignored action", async () => {
  let calls = 0;
  const waits = [];
  const recovered = await processAgentProposalActionUntilTerminal({
    isActive: () => true,
    operation: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient relay failure");
      return "complete";
    },
    wait: async (delayMs) => {
      waits.push(delayMs);
    },
  });

  assert.equal(recovered, "complete");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);

  let ignoredCalls = 0;
  const ignored = await processAgentProposalActionUntilTerminal({
    isActive: () => true,
    operation: async () => {
      ignoredCalls += 1;
      return "ignored";
    },
    wait: async () => {
      assert.fail("ignored actions must not retry");
    },
  });

  assert.equal(ignored, "ignored");
  assert.equal(ignoredCalls, 1);
});

test("only the owner processor's valid same-channel receipt is authoritative", () => {
  const fixture = signedProposalFixture();
  const receiptTemplate = {
    kind: 40011,
    created_at: 3,
    content: "{}",
    tags: [
      ["h", fixture.channelId],
      ["e", fixture.actionEvent.id, "", "block-action"],
      ["e", fixture.instanceEvent.id, "", "block-instance"],
      [
        "block-receipt",
        "1",
        REQUEST_ID,
        "44444444-4444-4444-8444-444444444444",
        "succeeded",
      ],
      ["block-attention", "1", "resolved"],
    ],
  };
  const ownerReceipt = finalizeEvent(
    structuredClone(receiptTemplate),
    fixture.ownerSecret,
  );
  const forgedReceipt = finalizeEvent(
    structuredClone(receiptTemplate),
    generateSecretKey(),
  );
  const authority = {
    ownerPubkey: fixture.ownerPubkey,
    channelId: fixture.channelId,
    actionEventId: fixture.actionEvent.id,
    instanceEventId: fixture.instanceEvent.id,
  };

  assert.equal(
    isAuthoritativeAgentProposalReceipt({
      receipt: ownerReceipt,
      ...authority,
    }),
    true,
  );
  assert.equal(
    isAuthoritativeAgentProposalReceipt({
      receipt: forgedReceipt,
      ...authority,
    }),
    false,
  );
});

test("production agent-management authorization no longer depends on observer frames", () => {
  const observerStore = readFileSync(
    new URL("../agents/observerRelayStore.ts", import.meta.url),
    "utf8",
  );
  const dialog = readFileSync(
    new URL("../agents/ui/AgentManagementDialogs.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(observerStore, /agent_management_request/i);
  assert.doesNotMatch(observerStore, /subscribeAgentManagementRequests/);
  assert.doesNotMatch(dialog, /useAgentManagement/);
  assert.match(observerStore, /control_result/);
});
