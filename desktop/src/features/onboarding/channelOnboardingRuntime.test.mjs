import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { createChannelOnboardingRuntime } from "./channelOnboardingRuntime.ts";
import {
  approvalRequestId,
  clone,
  currentProfile,
  expectedHeadEventId,
  ownerSecret,
  relayPubkey,
  relayUrl,
  rootEvent,
  scope,
  scoutPubkey,
  setupInput,
  signedAcknowledgement,
  signedReply,
  runtimeStatus,
  secondApprovalRequestId,
} from "./channelOnboardingRuntime/testFixtures.mjs";
import { WELCOME_GUIDE_PERSONA_ID, WELCOME_TEAM_ID } from "./welcomeGuide.ts";
import {
  scoutSetupAcknowledgementBody,
  scoutSetupAcknowledgementTag,
} from "./channelOnboardingSetup.ts";

function memoryStore(initial = null) {
  let value = initial ? clone(initial) : null;
  const writes = [];
  return {
    read: () => (value ? clone(value) : null),
    write: (_scope, next) => {
      value = clone(next);
      writes.push(clone(next));
    },
    withLock: (_scope, work) => work(),
    get: () => (value ? clone(value) : null),
    replace: (next) => {
      value = next ? clone(next) : null;
    },
    writes,
  };
}

function signedCompanyAction(profile, requestId) {
  const content = JSON.stringify({
    schema: "colony.company-action/v1",
    operation: "update",
    expectedHead: expectedHeadEventId,
    expectedReferences: [],
    payload: { kind: "company", record: profile },
  });
  return finalizeEvent(
    {
      kind: 40013,
      content,
      tags: [
        ["p", relayPubkey],
        ["a", `30179:${relayPubkey}:profile`],
        [
          "company-action",
          "1",
          "update",
          requestId,
          "33333333-3333-4333-8333-333333333333",
        ],
      ],
      created_at: 1_700_000_100,
    },
    ownerSecret,
  );
}

function successfulProof(
  acknowledgementEventId,
  requestId = approvalRequestId,
) {
  const reply = signedReply(acknowledgementEventId);
  return {
    proofId: `scout-setup:${acknowledgementEventId}:${reply.id}`,
    agentPubkey: scoutPubkey,
    channelId: scope.channelId,
    acknowledgementEventId,
    requestId,
    replyEventId: reply.id,
    signedReplyEvent: JSON.stringify(reply),
    turnId: "turn-1",
    recordIds: [reply.id],
    savedAt: new Date(1_700_000_500_000).toISOString(),
  };
}

function dependenciesFor(store, options = {}) {
  const actions = [];
  const submissions = [];
  const acknowledgements = [];
  const starts = [];
  const teams = [];
  const canvases = [];
  let submitCount = 0;
  const acknowledgementsByRequest = new Map();
  const deps = {
    attemptStore: store,
    assertCurrent: async () => {},
    loadOriginalRoot: async () => rootEvent,
    getRelaySelf: async () => relayPubkey,
    getCompanyHead: async () => ({
      ok: true,
      value: { profile: currentProfile, headEventId: expectedHeadEventId },
    }),
    signCompanyProfileUpdate: async ({ profile, requestId }) => {
      const action = signedCompanyAction(profile, requestId);
      actions.push(action);
      return JSON.stringify(action);
    },
    submitCompanyAction: async (signed) => {
      submissions.push(signed);
      submitCount += 1;
      if (options.submitOutcome)
        return options.submitOutcome(signed, submitCount);
      if (submitCount === 1) {
        return {
          status: "no-receipt",
          actionEventId: JSON.parse(signed).id,
          message: "pending",
        };
      }
      return {
        status: "applied",
        receiptEventId: "d".repeat(64),
        headEventId: "e".repeat(64),
        target: `30179:${relayPubkey}:profile`,
      };
    },
    readCompanyActionReceipt: async (actionEventId) => {
      const saved = store.get();
      return saved?.profileReceipt
        ? { ...saved.profileReceipt, actionEventId }
        : null;
    },
    ensureCanvas: async (channel) => {
      canvases.push(channel);
      return true;
    },
    ensureTeam: async (channel, relay) => {
      teams.push([channel, relay]);
      if (options.ensureTeam) return options.ensureTeam(channel, relay);
      return { agents: [{ pubkey: scoutPubkey, teamId: WELCOME_TEAM_ID }] };
    },
    startRuntime: async (pubkey, relay, owner) => {
      starts.push([pubkey, relay, owner]);
      if (options.startRuntime)
        return options.startRuntime(pubkey, relay, owner);
      return runtimeStatus();
    },
    readScoutRuntime: async (pubkey, relay, channel) => {
      if (options.readScoutRuntime)
        return options.readScoutRuntime(pubkey, relay, channel);
      return {
        agent: {
          pubkey,
          relayUrl: relay,
          teamId: WELCOME_TEAM_ID,
          personaId: WELCOME_GUIDE_PERSONA_ID,
        },
        status: runtimeStatus(),
      };
    },
    deliverAcknowledgement: async (input) => {
      acknowledgements.push(input);
      if (options.deliverAcknowledgement) {
        return options.deliverAcknowledgement(input);
      }
      const acknowledgement =
        acknowledgementsByRequest.get(input.requestId) ??
        signedAcknowledgement(input.input, input.requestId);
      acknowledgementsByRequest.set(input.requestId, acknowledgement);
      return {
        eventId: acknowledgement.id,
        signedEvent: JSON.stringify(acknowledgement),
        published: true,
      };
    },
    verifyScoutReply: async (input) => {
      if (options.verifyScoutReply) return options.verifyScoutReply(input);
      return successfulProof(input.acknowledgement.eventId, input.requestId);
    },
    now: () => 1_700_000_500_000,
  };
  return {
    deps,
    actions,
    submissions,
    acknowledgements,
    starts,
    teams,
    canvases,
    get acknowledgement() {
      return [...acknowledgementsByRequest.values()][0] ?? null;
    },
  };
}

test("approval stores and retries the same signed profile action after an uncertain receipt", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store);
  const runtime = createChannelOnboardingRuntime(scope, f.deps);

  await assert.rejects(
    runtime.approve(setupInput, approvalRequestId),
    /awaiting confirmation|pending/,
  );
  const pending = store.get();
  assert.equal(pending.phase, "profile-signed");
  assert.equal(f.actions.length, 1);
  assert.equal(f.submissions.length, 1);

  const proof = await runtime.approve(setupInput, approvalRequestId);
  assert.equal(f.actions.length, 1, "retry must not sign a second action");
  assert.equal(f.submissions.length, 2);
  assert.equal(f.submissions[0], f.submissions[1]);
  assert.equal(f.acknowledgements.length, 1);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.teams, [[scope.channelId, relayUrl]]);
  assert.deepEqual(f.canvases, [scope.channelId]);
  assert.equal(proof.agentPubkey, scoutPubkey);
  assert.equal(store.get().phase, "ready");
});

test("short relay quota windows retry the preflight read before signing", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
  });
  const delays = [];
  let rootReads = 0;
  f.deps.delay = async (milliseconds) => {
    delays.push(milliseconds);
  };
  f.deps.loadOriginalRoot = async () => {
    rootReads += 1;
    if (rootReads === 1) {
      throw new Error("rate-limited: quota exceeded; retry in 4s");
    }
    return rootEvent;
  };

  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  const proof = await runtime.approve(setupInput, approvalRequestId);

  assert.equal(proof.agentPubkey, scoutPubkey);
  assert.equal(rootReads, 2);
  assert.deepEqual(delays, [4_000]);
  assert.equal(f.actions.length, 1);
  assert.equal(f.submissions.length, 1);
});

test("a rate-limited company head outcome retries before signing", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
  });
  const delays = [];
  let headReads = 0;
  f.deps.delay = async (milliseconds) => {
    delays.push(milliseconds);
  };
  f.deps.getCompanyHead = async () => {
    headReads += 1;
    if (headReads === 1) {
      return {
        ok: false,
        code: "unavailable",
        message:
          "Company records could not be read: rate-limited: quota exceeded; retry in 4s",
      };
    }
    return {
      ok: true,
      value: { profile: currentProfile, headEventId: expectedHeadEventId },
    };
  };

  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await runtime.approve(setupInput, approvalRequestId);

  assert.equal(headReads, 2);
  assert.deepEqual(delays, [4_000]);
  assert.equal(f.actions.length, 1);
});

test("a changed snapshot gets a new approval action after a completed setup", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: (_signed, count) => ({
      status: "applied",
      receiptEventId: `${"d".repeat(63)}${count}`,
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
  });
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  const first = await runtime.approve(setupInput, approvalRequestId);
  const changed = clone(setupInput);
  changed.setupDescription = "A second owner-approved context.";
  const second = await runtime.approve(changed, secondApprovalRequestId);

  assert.notEqual(first.proofId, second.proofId);
  assert.equal(f.actions.length, 2);
  assert.equal(
    JSON.parse(f.actions[0].content).payload.record.summary,
    setupInput.setupDescription,
  );
  assert.equal(
    JSON.parse(f.actions[1].content).payload.record.summary,
    changed.setupDescription,
  );
  assert.equal(store.get().approvalRequestId, secondApprovalRequestId);
});

test("an edited snapshot cannot replace an unresolved signed action", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store);
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await assert.rejects(runtime.approve(setupInput, approvalRequestId));
  const changed = clone(setupInput);
  changed.setupDescription = "Do not overwrite the pending action.";
  await assert.rejects(
    runtime.approve(changed, secondApprovalRequestId),
    /still being resolved|Retry it/,
  );
  assert.equal(f.actions.length, 1);
  assert.equal(f.submissions.length, 1);
});

test("stale owner is checked before signing or submission", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store);
  let checks = 0;
  f.deps.assertCurrent = async () => {
    checks += 1;
    if (checks > 1) throw new Error("owner changed");
  };
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await assert.rejects(
    runtime.approve(setupInput, approvalRequestId),
    /owner changed/,
  );
  assert.equal(f.actions.length, 0);
  assert.equal(f.submissions.length, 0);
  assert.equal(store.get(), null);
});

test("an invalid signed root fails the approval gate without setup side effects", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store);
  f.deps.loadOriginalRoot = async () =>
    finalizeEvent(
      {
        ...rootEvent,
        pubkey: undefined,
        created_at: rootEvent.created_at,
      },
      new Uint8Array(32).fill(6),
    );
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await assert.rejects(
    runtime.approve(setupInput, approvalRequestId),
    /different account|verification|approval/,
  );
  assert.equal(f.actions.length, 0);
  assert.equal(f.submissions.length, 0);
});

test("a forged saved proof cannot restore ready or run a new runtime", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: (_signed) => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
  });
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await runtime.approve(setupInput, approvalRequestId);
  const saved = store.get();
  saved.proof.signedReplyEvent = JSON.stringify(
    signedReply(saved.acknowledgement.eventId, ownerSecret),
  );
  store.replace(saved);
  const starts = f.starts.length;
  await assert.rejects(
    runtime.reconcileSavedProof(setupInput),
    /signed message|different agent|setup reply/,
  );
  assert.equal(f.starts.length, starts);
  assert.equal(f.acknowledgements.length, 1);
});

test("reload stays read-only while an explicit retry restarts a stopped Scout", async () => {
  const store = memoryStore();
  let live = null;
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
    readScoutRuntime: async () => live,
    ensureTeam: () => ({
      agents: [{ pubkey: scoutPubkey, teamId: WELCOME_TEAM_ID }],
    }),
    startRuntime: async (pubkey, relay, _owner) => {
      live = {
        agent: {
          pubkey,
          relayUrl: relay,
          teamId: WELCOME_TEAM_ID,
          personaId: WELCOME_GUIDE_PERSONA_ID,
        },
        status: runtimeStatus(),
      };
      return runtimeStatus();
    },
  });
  live = {
    agent: {
      pubkey: scoutPubkey,
      relayUrl,
      teamId: WELCOME_TEAM_ID,
      personaId: WELCOME_GUIDE_PERSONA_ID,
    },
    status: runtimeStatus(),
  };
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await runtime.approve(setupInput, approvalRequestId);
  const completed = {
    actions: f.actions.length,
    submissions: f.submissions.length,
    canvases: f.canvases.length,
    teams: f.teams.length,
    starts: f.starts.length,
    acknowledgements: f.acknowledgements.length,
    writes: store.writes.length,
  };
  live = null;
  await assert.rejects(
    runtime.reconcileSavedProof(setupInput),
    /current Welcome runtime|no longer matches/,
  );
  assert.deepEqual(
    {
      actions: f.actions.length,
      submissions: f.submissions.length,
      canvases: f.canvases.length,
      teams: f.teams.length,
      starts: f.starts.length,
      acknowledgements: f.acknowledgements.length,
      writes: store.writes.length,
    },
    completed,
  );

  const proof = await runtime.approve(setupInput, approvalRequestId);
  assert.equal(proof.proofId, store.get().proof.proofId);
  assert.equal(f.actions.length, completed.actions);
  assert.equal(f.submissions.length, completed.submissions);
  assert.equal(f.acknowledgements.length, completed.acknowledgements);
  assert.equal(f.starts.length, completed.starts + 1);
  assert.equal(f.teams.length, completed.teams + 1);
  assert.equal(f.canvases.length, completed.canvases + 1);
  assert.equal(store.get().phase, "ready");
});

test("reload stays read-only while an explicit retry replaces a removed Scout", async () => {
  const store = memoryStore();
  const replacementSecret = new Uint8Array(32).fill(10);
  const replacementPubkey = getPublicKey(replacementSecret);
  let replacement = false;
  let live = {
    agent: {
      pubkey: scoutPubkey,
      relayUrl,
      teamId: WELCOME_TEAM_ID,
      personaId: WELCOME_GUIDE_PERSONA_ID,
    },
    status: runtimeStatus(),
  };
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
    readScoutRuntime: async () => live,
    ensureTeam: () => ({
      agents: [
        {
          pubkey: replacement ? replacementPubkey : scoutPubkey,
          teamId: WELCOME_TEAM_ID,
        },
      ],
    }),
    startRuntime: async (pubkey, relay, _owner) => {
      const status = { ...runtimeStatus(), pubkey, relayUrl: relay };
      live = {
        agent: {
          pubkey,
          relayUrl: relay,
          teamId: WELCOME_TEAM_ID,
          personaId: WELCOME_GUIDE_PERSONA_ID,
        },
        status,
      };
      return status;
    },
    deliverAcknowledgement: async (input) => {
      const acknowledgement =
        input.scoutPubkey === scoutPubkey
          ? signedAcknowledgement(input.input, input.requestId)
          : finalizeEvent(
              {
                kind: 9,
                content: scoutSetupAcknowledgementBody(input.input),
                tags: [
                  ["h", scope.channelId],
                  ["p", replacementPubkey],
                  ["e", rootEvent.id, "", "reply"],
                  scoutSetupAcknowledgementTag(input.input, input.requestId),
                ],
                created_at: 1_700_000_200,
              },
              ownerSecret,
            );
      return {
        eventId: acknowledgement.id,
        signedEvent: JSON.stringify(acknowledgement),
        published: true,
      };
    },
    verifyScoutReply: async (input) => {
      if (input.scoutPubkey === scoutPubkey) {
        return successfulProof(input.acknowledgement.eventId, input.requestId);
      }
      const reply = finalizeEvent(
        {
          kind: 9,
          content: "Replacement Scout confirms the approved context is ready.",
          tags: [
            ["h", scope.channelId],
            ["e", rootEvent.id, "", "root"],
            ["e", input.acknowledgement.eventId, "", "reply"],
          ],
          created_at: 1_700_000_400,
        },
        replacementSecret,
      );
      return {
        proofId: `scout-setup:${input.acknowledgement.eventId}:${reply.id}`,
        agentPubkey: replacementPubkey,
        channelId: scope.channelId,
        acknowledgementEventId: input.acknowledgement.eventId,
        requestId: input.requestId,
        replyEventId: reply.id,
        signedReplyEvent: JSON.stringify(reply),
        turnId: "replacement-turn-1",
        recordIds: [reply.id],
        savedAt: new Date(1_700_000_500_000).toISOString(),
      };
    },
  });
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await runtime.approve(setupInput, approvalRequestId);
  const completed = {
    actions: f.actions.length,
    submissions: f.submissions.length,
    acknowledgements: f.acknowledgements.length,
    starts: f.starts.length,
    teams: f.teams.length,
    canvases: f.canvases.length,
    writes: store.writes.length,
    profileActionEventId: store.get().profileActionEventId,
  };
  live = null;
  await assert.rejects(runtime.reconcileSavedProof(setupInput));
  assert.deepEqual(
    {
      actions: f.actions.length,
      submissions: f.submissions.length,
      acknowledgements: f.acknowledgements.length,
      starts: f.starts.length,
      teams: f.teams.length,
      canvases: f.canvases.length,
      writes: store.writes.length,
      profileActionEventId: store.get().profileActionEventId,
    },
    completed,
  );

  replacement = true;
  const proof = await runtime.approve(setupInput, approvalRequestId);
  assert.equal(proof.agentPubkey, replacementPubkey);
  assert.equal(store.get().scoutPubkey, replacementPubkey);
  assert.equal(f.actions.length, completed.actions);
  assert.equal(f.submissions.length, completed.submissions);
  assert.equal(f.acknowledgements.length, completed.acknowledgements + 1);
  assert.equal(f.starts.length, completed.starts + 1);
  assert.equal(f.teams.length, completed.teams + 1);
  assert.equal(f.canvases.length, completed.canvases + 1);
  assert.equal(store.get().phase, "ready");
});

test("multiple Welcome agents stop Scout setup before runtime or acknowledgement", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
    ensureTeam: () => ({
      agents: [
        { pubkey: scoutPubkey, teamId: WELCOME_TEAM_ID },
        { pubkey: "f".repeat(64), teamId: WELCOME_TEAM_ID },
      ],
    }),
  });
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await assert.rejects(
    runtime.approve(setupInput, approvalRequestId),
    /more than the one approved/,
  );
  assert.equal(f.starts.length, 0);
  assert.equal(f.acknowledgements.length, 0);
  assert.equal(store.get().phase, "profile-applied");
});

test("reconcileSavedProof is read-only and validates receipt, acknowledgement, and signed reply", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store, {
    submitOutcome: () => ({
      status: "applied",
      receiptEventId: "d".repeat(64),
      headEventId: "e".repeat(64),
      target: `30179:${relayPubkey}:profile`,
    }),
  });
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  const expected = await runtime.approve(setupInput, approvalRequestId);
  const writeCount = store.writes.length;
  const startCount = f.starts.length;
  const proof = await runtime.reconcileSavedProof(setupInput);
  assert.deepEqual(proof, expected);
  assert.equal(store.writes.length, writeCount);
  assert.equal(f.starts.length, startCount);
  assert.equal(f.acknowledgements.length, 1);
});

test("reconcileSavedProof returns null while an interrupted setup remains pending", async () => {
  const store = memoryStore();
  const f = dependenciesFor(store);
  const runtime = createChannelOnboardingRuntime(scope, f.deps);
  await assert.rejects(runtime.approve(setupInput, approvalRequestId));
  assert.equal(await runtime.reconcileSavedProof(setupInput), null);
});
