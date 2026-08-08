import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  getLatestColonyCreditsDenial,
  injectObserverEventsForE2E,
  resetAgentObserverStore,
} from "./observerRelayStore.ts";

const AGENT = "a".repeat(64);

function event(overrides = {}) {
  return {
    seq: 1,
    timestamp: "2026-01-01T00:00:01.000Z",
    kind: "turn_error",
    agentIndex: 0,
    channelId: "channel-1",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: {
      gateway_status: 401,
      action: "reconnect",
      error: "upstream returned 401",
    },
    ...overrides,
  };
}

describe("observerRelayStore Colony Credits recovery", () => {
  beforeEach(() => resetAgentObserverStore());

  it("keeps a live 401 denial available to the managed-agent row", () => {
    injectObserverEventsForE2E(AGENT, [event()]);
    assert.equal(
      getLatestColonyCreditsDenial(AGENT)?.payload.gateway_status,
      401,
    );
  });

  it("clears a denial when a later turn starts", () => {
    injectObserverEventsForE2E(AGENT, [
      event(),
      event({
        seq: 2,
        timestamp: "2026-01-01T00:00:02.000Z",
        kind: "turn_started",
        payload: null,
      }),
    ]);
    assert.equal(getLatestColonyCreditsDenial(AGENT), null);
  });
});
