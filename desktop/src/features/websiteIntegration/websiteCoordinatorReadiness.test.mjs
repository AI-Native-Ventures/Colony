import assert from "node:assert/strict";
import test from "node:test";

import { ensureWebsiteCoordinatorReady } from "./websiteCoordinatorReadiness.ts";

const OWNER = "a".repeat(64);
const COORDINATOR = "b".repeat(64);
const RELAY = "ws://localhost:3000";

function coordinator(
  pubkey = COORDINATOR,
  relayUrl = RELAY,
  backend = { type: "local" },
) {
  return {
    pubkey,
    name: "Avery",
    relayUrl,
    status: "stopped",
    backend,
  };
}

function runtime(
  lifecycle,
  pubkey = COORDINATOR,
  relayUrl = "ws://127.0.0.1:3000",
  localSetup = true,
) {
  return {
    pubkey,
    relayUrl,
    localSetup,
    lifecycle,
    pid: 42,
    error: null,
    logPath: null,
  };
}

function baseInput(overrides = {}) {
  return {
    communityId: "community-a",
    relayUrl: RELAY,
    ownerPubkey: OWNER,
    channelId: "community-a-channel",
    coordinatorPubkey: COORDINATOR,
    loadManagedAgents: async () => [coordinator()],
    getActiveCommunityId: () => "community-a",
    ensureObserver: async () => {},
    ...overrides,
  };
}

test("a stopped local coordinator waits for ACP listening before the action is sent", async () => {
  const agent = coordinator();
  let attached = null;
  let started = null;
  let observed = false;
  let listCalls = 0;
  let now = 0;

  const ready = await ensureWebsiteCoordinatorReady({
    ...baseInput({ loadManagedAgents: async () => [agent] }),
    ensureObserver: async (pubkey) => {
      assert.equal(pubkey, COORDINATOR);
      observed = true;
    },
    attachAgent: async (channelId, input) => {
      attached = { channelId, input };
      return { agent, membershipAdded: true, started: false };
    },
    startRuntime: async (pubkey, relayUrl, ownerPubkey) => {
      started = { pubkey, relayUrl, ownerPubkey };
      return runtime("starting", pubkey);
    },
    listRuntimeStatuses: async () => {
      listCalls += 1;
      return [runtime(listCalls === 1 ? "starting" : "listening")];
    },
    now: () => now,
    delay: async (ms) => {
      now += ms;
    },
  });

  assert.equal(attached.channelId, "community-a-channel");
  assert.equal(attached.input.agent, agent);
  assert.equal(attached.input.role, "bot");
  assert.equal(attached.input.ensureRunning, false);
  assert.equal(observed, true);
  assert.equal(ready.membershipAdded, true);
  assert.equal(ready.started, false);
  assert.deepEqual(started, {
    pubkey: COORDINATOR,
    relayUrl: RELAY,
    ownerPubkey: OWNER,
  });
  assert.equal(listCalls, 2);
});

test("a coordinator pinned to another relay fails before attachment", async () => {
  let attached = false;
  await assert.rejects(
    () =>
      ensureWebsiteCoordinatorReady(
        baseInput({
          loadManagedAgents: async () => [
            coordinator(COORDINATOR, "wss://another-community.example"),
          ],
          attachAgent: async () => {
            attached = true;
            return {
              agent: coordinator(),
              membershipAdded: false,
              started: false,
            };
          },
        }),
      ),
    /coordinator is unavailable/,
  );
  assert.equal(attached, false);
});

test("a stopped ACP status refuses the start and does not manufacture success", async () => {
  await assert.rejects(
    () =>
      ensureWebsiteCoordinatorReady(
        baseInput({
          now: () => 15_000,
          listRuntimeStatuses: async () => [runtime("stopped")],
          attachAgent: async () => ({
            agent: coordinator(),
            membershipAdded: false,
            started: false,
          }),
          startRuntime: async () => runtime("starting"),
        }),
      ),
    /website coordinator could not start/,
  );
});

test("ACP listening without local setup refuses a paid-model start", async () => {
  await assert.rejects(
    () =>
      ensureWebsiteCoordinatorReady(
        baseInput({
          listRuntimeStatuses: async () => [
            runtime("listening", COORDINATOR, RELAY, false),
          ],
          attachAgent: async () => ({
            agent: coordinator(),
            membershipAdded: false,
            started: false,
          }),
          startRuntime: async () => runtime("starting"),
        }),
      ),
    /website coordinator could not start/,
  );
});

test("a community switch during managed-agent loading fails before attachment", async () => {
  let activeCommunity = "community-a";
  let attached = false;
  await assert.rejects(
    () =>
      ensureWebsiteCoordinatorReady(
        baseInput({
          getActiveCommunityId: () => activeCommunity,
          loadManagedAgents: async () => {
            activeCommunity = "community-b";
            return [coordinator()];
          },
          attachAgent: async () => {
            attached = true;
            return {
              agent: coordinator(),
              membershipAdded: false,
              started: false,
            };
          },
        }),
      ),
    /community changed/,
  );
  assert.equal(attached, false);
});

test("a community switch after attachment prevents runtime start", async () => {
  let activeCommunity = "community-a";
  let started = false;
  await assert.rejects(
    () =>
      ensureWebsiteCoordinatorReady(
        baseInput({
          getActiveCommunityId: () => activeCommunity,
          attachAgent: async () => {
            activeCommunity = "community-b";
            return {
              agent: coordinator(),
              membershipAdded: true,
              started: false,
            };
          },
          startRuntime: async () => {
            started = true;
            return runtime("starting");
          },
        }),
      ),
    /community changed/,
  );
  assert.equal(started, false);
});
