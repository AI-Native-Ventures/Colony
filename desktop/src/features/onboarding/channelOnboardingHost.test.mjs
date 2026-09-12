import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { createInitialScoutOnboardingState } from "./channelOnboarding/state.ts";
import {
  createScoutOnboardingRootPayload,
  scoutOnboardingRootTags,
} from "./channelOnboardingRuntime/protocol.ts";
import {
  hydrateScoutOnboardingState,
  isScoutOnboardingStateEnvelope,
  requestIdForScoutSetup,
  scoutOnboardingScopeKey,
  shouldAdoptScoutOnboardingStorageState,
} from "./channelOnboardingHost.tsx";
import {
  getVerifiedScoutOnboardingMount,
  scoutOnboardingRootQueryKey,
} from "./ui/ScoutOnboardingMessage.tsx";

const ownerKey = new Uint8Array(32).fill(23);
const ownerPubkey = getPublicKey(ownerKey);
const scope = {
  ownerPubkey,
  relayUrl: "wss://relay.example",
  channelId: "welcome",
  threadRootId: "0".repeat(64),
  requestId: "signup-1",
};

function setupInput(overrides = {}) {
  return {
    route: "existing",
    summary: {
      route: "existing",
      person: "Ari",
      businessOrIdea: "Acme",
      priority: "delivery",
      priorityId: "delivery",
      unknowns: [],
      website: "https://acme.example",
      websiteState: "provided",
      location: null,
    },
    setupName: "Acme",
    setupDescription: "A local service business.",
    ...overrides,
  };
}

function signedRoot() {
  const payload = createScoutOnboardingRootPayload(
    {
      ownerPubkey,
      relayUrl: scope.relayUrl,
      channelId: scope.channelId,
      requestId: scope.requestId,
    },
    { ownerName: "Ari", businessName: "Acme", hasWebsite: false },
  );
  return finalizeEvent(
    {
      kind: 9,
      content: "Welcome to Colony.",
      created_at: 1_757_700_000,
      tags: scoutOnboardingRootTags(payload),
    },
    ownerKey,
  );
}

test("host helpers isolate scope, reject stale storage updates, and key root reads", () => {
  const otherScope = { ...scope, threadRootId: "1".repeat(64) };
  assert.notEqual(
    scoutOnboardingScopeKey(scope),
    scoutOnboardingScopeKey(otherScope),
  );
  assert.deepEqual(
    scoutOnboardingRootQueryKey(scope.relayUrl, scope.threadRootId),
    ["scout-onboarding-root", scope.relayUrl, scope.threadRootId],
  );
  assert.equal(
    shouldAdoptScoutOnboardingStorageState({
      currentSerialized: "new",
      incomingSerialized: "new",
      lastPersistedSerialized: "old",
    }),
    false,
  );
  assert.equal(
    shouldAdoptScoutOnboardingStorageState({
      currentSerialized: "old",
      incomingSerialized: "new",
      lastPersistedSerialized: "old",
    }),
    true,
  );
});

test("hydrating a cached ready state clears its proof and requires runtime verification", () => {
  const state = createInitialScoutOnboardingState({
    signupContext: { ownerName: "Ari" },
  });
  const cachedReady = {
    ...state,
    stage: "ready",
    setup: {
      ...state.setup,
      phase: "ready",
      requestId: null,
      proof: { proofId: "verified-before-reload" },
    },
  };
  assert.equal(isScoutOnboardingStateEnvelope(cachedReady), true);
  const hydrated = hydrateScoutOnboardingState(
    cachedReady,
    state.signupContext,
  );
  assert.equal(hydrated.stage, "setting-up");
  assert.equal(hydrated.setup.phase, "error");
  assert.equal(hydrated.setup.proof, null);
  assert.match(hydrated.notice ?? "", /quick check after reload/);

  const invalid = {
    ...cachedReady,
    setup: { ...cachedReady.setup, proof: { proofId: "  " } },
  };
  assert.equal(isScoutOnboardingStateEnvelope(invalid), false);
});

test("setup request ids reuse only an exact durable snapshot and otherwise remain UUIDs", () => {
  const input = setupInput();
  const durableRequestId = "12345678-1234-4234-8234-123456789abc";
  const runtime = {
    readAttempt: () => ({ approvalRequestId: durableRequestId, input }),
  };
  assert.equal(
    requestIdForScoutSetup(runtime, "legacy-request-label", input),
    durableRequestId,
  );

  const changed = setupInput({ setupDescription: "A changed description." });
  const candidate = "12345678-1234-4234-8234-123456789abd";
  assert.equal(requestIdForScoutSetup(runtime, candidate, changed), candidate);
  assert.match(
    requestIdForScoutSetup(runtime, "legacy-request-label", changed),
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
});

test("interactive onboarding mounts only for the current owner's verified signed root", () => {
  const root = signedRoot();
  const message = {
    id: root.id,
    kind: 9,
    pending: false,
    pubkey: ownerPubkey,
    signerPubkey: ownerPubkey,
    parentId: null,
    rootId: null,
  };
  const verified = getVerifiedScoutOnboardingMount({
    message,
    rootEvent: root,
    channelId: scope.channelId,
    activeRelayUrl: scope.relayUrl,
    currentPubkey: ownerPubkey,
    identityPubkey: ownerPubkey,
  });
  assert.equal(verified?.scope.threadRootId, root.id);
  assert.equal(verified?.payload.seed.websiteState, "none");

  assert.equal(
    getVerifiedScoutOnboardingMount({
      message,
      rootEvent: root,
      channelId: "other-channel",
      activeRelayUrl: scope.relayUrl,
      currentPubkey: ownerPubkey,
      identityPubkey: ownerPubkey,
    }),
    null,
  );
  assert.equal(
    getVerifiedScoutOnboardingMount({
      message,
      rootEvent: root,
      channelId: scope.channelId,
      activeRelayUrl: scope.relayUrl,
      currentPubkey: "f".repeat(64),
      identityPubkey: "f".repeat(64),
    }),
    null,
  );
});
