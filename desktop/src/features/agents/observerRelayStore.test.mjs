import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  getLatestColonyCreditsDenial,
  injectObserverEventsForE2E,
  resetAgentObserverStore,
} from "./observerRelayStore.ts";

const AGENT = "a".repeat(64);

function event(status = 401, overrides = {}) {
  const marker =
    status === 402
      ? "COLONY_CREDITS_GATEWAY_STATUS_402"
      : "COLONY_CREDITS_GATEWAY_STATUS_401";
  return {
    seq: 1,
    timestamp: "2026-01-01T00:00:01.000Z",
    kind: "turn_error",
    agentIndex: 0,
    channelId: "channel-1",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: {
      gateway_status: status,
      gateway_marker: marker,
      action: "reconnect",
      error: `meter marker ${marker}`,
    },
    ...overrides,
  };
}

describe("observerRelayStore Colony Credits recovery", () => {
  beforeEach(() => resetAgentObserverStore());

  it("keeps a live 401 denial available to the managed-agent row", () => {
    injectObserverEventsForE2E(AGENT, [event(401)]);
    assert.equal(
      getLatestColonyCreditsDenial(AGENT)?.payload.gateway_status,
      401,
    );
  });

  it("clears a denial when a later turn starts", () => {
    injectObserverEventsForE2E(AGENT, [
      event(401),
      event(401, {
        seq: 2,
        timestamp: "2026-01-01T00:00:02.000Z",
        kind: "turn_started",
        payload: null,
      }),
    ]);
    assert.equal(getLatestColonyCreditsDenial(AGENT), null);
  });

  it("keeps an exact 402 depleted marker actionable", () => {
    injectObserverEventsForE2E(AGENT, [event(402)]);
    assert.equal(
      getLatestColonyCreditsDenial(AGENT)?.payload.gateway_status,
      402,
    );
  });

  it("ignores a status without the canonical meter marker", () => {
    injectObserverEventsForE2E(AGENT, [
      event(401, {
        payload: {
          gateway_status: 401,
          gateway_marker: "adapter mentioned 401",
          action: "reconnect",
        },
      }),
    ]);
    assert.equal(getLatestColonyCreditsDenial(AGENT), null);
  });
});
