import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, mock } from "node:test";

import {
  deriveAgentLivenessState,
  describeAgentLiveness,
  formatLastActive,
  FRAME_STALE_AFTER_MS,
  OUTPUT_QUIET_AFTER_MS,
} from "./agentLivenessState.ts";
import { REMOVE_AFTER_MS } from "./activeAgentTurnsStore.ts";
import {
  getLastTurnDeparture,
  noteObserverFrame,
  recordTurnDeparture,
  resetAgentLivenessLedger,
  setObserverTransportOpen,
} from "./agentLivenessLedger.ts";
import {
  getLiveTurnSamplesForAgent,
  resetActiveAgentTurnsStore,
  subscribeActiveAgentTurns,
  syncAgentTurnsFromEvents,
} from "./activeAgentTurnsStore.ts";

const AGENT =
  "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
const AGENT_2 =
  "dcba4321dcba4321dcba4321dcba4321dcba4321dcba4321dcba4321dcba4321";

const NOW = Date.parse("2024-06-01T12:00:00Z");

function makeEvent(overrides) {
  return {
    seq: 1,
    timestamp: "2024-06-01T12:00:00Z",
    kind: "turn_started",
    agentIndex: 0,
    channelId: "chan-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    payload: null,
    ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    channelId: "chan-1",
    anchorAt: NOW - 30_000,
    lastFrameAt: NOW - 5_000,
    lastOutputAt: NOW - 20_000,
    ...overrides,
  };
}

function departure(overrides = {}) {
  return {
    turnId: "t1",
    channelId: "chan-1",
    reason: "vanished",
    lastFrameAt: NOW - 300_000,
    lastOutputAt: null,
    departedAt: NOW - 290_000,
    terminalKind: null,
    corroboration: "none",
    ...overrides,
  };
}

function derive(overrides = {}) {
  const input = {
    liveTurns: [],
    lastDeparture: null,
    inFlightTool: null,
    presence: undefined,
    presenceLoaded: false,
    process: "ready",
    now: NOW,
    ...overrides,
  };
  return deriveAgentLivenessState(input);
}

describe("agentLivenessState constants stay in lockstep with the store", () => {
  it("FRAME_STALE_AFTER_MS equals the turn store's REMOVE_AFTER_MS", () => {
    // The liveness read must go "cannot tell" in exactly the window where the
    // store is either about to prune the turn or holding it under the bounded
    // frame-gap pause. If one bound drifts, a live turn either renders stale
    // verdicts or vanishes before the badge can name the gap.
    assert.equal(FRAME_STALE_AFTER_MS, REMOVE_AFTER_MS);
    assert.equal(FRAME_STALE_AFTER_MS, 25_000);
  });

  it("OUTPUT_QUIET_AFTER_MS is the documented one-minute quiet bound", () => {
    assert.equal(OUTPUT_QUIET_AFTER_MS, 60_000);
  });
});

describe("deriveAgentLivenessState: live turns", () => {
  it("frames plus recent output read as working", () => {
    const state = derive({ liveTurns: [sample()] });
    assert.equal(state.phase, "working");
    assert.equal(state.label, "Working");
    assert.equal(state.detail, null);
    assert.equal(state.sinceKind, "working-for");
    assert.equal(state.sinceAt, NOW - 30_000);
    assert.deepEqual(state.channels, ["chan-1"]);
    assert.equal(state.tone, "active");
    assert.equal(state.needsAttention, false);
  });

  it("a never-spoken young turn is working, not quiet", () => {
    // lastOutputAt null but the turn is young: quietSince falls back to the
    // anchor, which is inside the one-minute bound.
    const state = derive({
      liveTurns: [sample({ anchorAt: NOW - 5_000, lastOutputAt: null })],
    });
    assert.equal(state.phase, "working");
  });

  it("one producing turn redeems a quiet sibling across turns", () => {
    // Newest activity wins, deliberately: an agent with two live turns is
    // judged by its busiest one, so a quiet channel cannot drag a demonstrably
    // busy agent down to "quiet".
    const state = derive({
      liveTurns: [
        sample({
          channelId: "quiet",
          anchorAt: NOW - 10 * 60_000,
          lastFrameAt: NOW - 5_000,
          lastOutputAt: null,
        }),
        sample({ channelId: "chatty" }),
      ],
    });
    assert.equal(state.phase, "working");
    assert.deepEqual(state.channels, ["chatty", "quiet"]);
  });

  it("fresh frames with stale output read as working quietly", () => {
    const state = derive({
      liveTurns: [sample({ anchorAt: NOW - 70_000, lastOutputAt: null })],
    });
    assert.equal(state.phase, "working-quietly");
    assert.equal(state.label, "Working quietly");
    assert.equal(
      state.detail,
      "Still running. It has not had anything to report for a while.",
    );
    assert.equal(state.sinceKind, "last-active");
    assert.equal(state.sinceAt, NOW - 70_000);
    assert.equal(state.tone, "quiet");
    assert.equal(state.needsAttention, false);
  });

  it("working quietly names the in-flight tool and anchors to its start", () => {
    const state = derive({
      liveTurns: [sample({ anchorAt: NOW - 70_000, lastOutputAt: null })],
      inFlightTool: { title: "Running tests", startedAt: NOW - 45_000 },
    });
    assert.equal(state.phase, "working-quietly");
    assert.equal(state.detail, "Still running: Running tests.");
    assert.equal(state.sinceAt, NOW - 45_000);
  });

  it("exactly sixty seconds of quiet is still working; one ms more is quiet", () => {
    const atBound = derive({
      liveTurns: [sample({ lastOutputAt: NOW - 60_000 })],
    });
    assert.equal(atBound.phase, "working");

    const pastBound = derive({
      liveTurns: [sample({ lastOutputAt: NOW - 60_001 })],
    });
    assert.equal(pastBound.phase, "working-quietly");
  });

  it("frames stopped past the stale bound read as cannot tell, never stalled", () => {
    // The bounded pause window: the store still holds the turn, so a verdict
    // like "Not responding" would convict a healthy agent of a transport
    // fault. The honest answer is that nothing is arriving.
    const state = derive({
      liveTurns: [sample({ lastFrameAt: NOW - 25_001 })],
    });
    assert.equal(state.phase, "cannot-tell");
    assert.equal(state.label, "No signal");
    assert.equal(
      state.detail,
      "Colony has stopped receiving updates from this agent.",
    );
    assert.equal(state.sinceKind, "last-active");
    // Anchored to the last readable output when there was one, else the last
    // frame of any kind.
    assert.equal(state.sinceAt, NOW - 20_000);
    assert.equal(state.tone, "warning");
    assert.equal(state.needsAttention, true);
    assert.deepEqual(state.channels, ["chan-1"]);

    const neverSpoke = derive({
      liveTurns: [sample({ lastFrameAt: NOW - 25_001, lastOutputAt: null })],
    });
    assert.equal(neverSpoke.sinceAt, NOW - 25_001);
  });

  it("exactly twenty-five seconds of frame silence is not yet cannot tell", () => {
    const state = derive({
      liveTurns: [
        sample({ lastFrameAt: NOW - 25_000, lastOutputAt: NOW - 25_000 }),
      ],
    });
    assert.equal(state.phase, "working");
  });
});

describe("deriveAgentLivenessState: departed turns", () => {
  it("a terminal outcome explains the silence: ended is idle, never stalled", () => {
    // The quiet agent's turn_error / turn_completed arrived. Whatever the
    // silence looked like, it is resolved, so the badge must not render a
    // stall from a departure the terminal already accounted for.
    for (const reason of ["ended", "cleared", "evicted"]) {
      const state = derive({ lastDeparture: departure({ reason }) });
      assert.equal(state.phase, "idle", `reason ${reason}`);
      assert.equal(state.label, "Ready");
      assert.equal(state.sinceKind, "last-active");
      assert.equal(state.sinceAt, NOW - 290_000);
    }
  });

  it("vanished with no corroboration is cannot tell, not stalled", () => {
    // A single-agent community always lands here. Absence of frames is not
    // evidence against the agent, so the honest verdict is ambiguity.
    const state = derive({ lastDeparture: departure() });
    assert.equal(state.phase, "cannot-tell");
    assert.equal(state.detail.includes("cannot tell"), true);
    assert.equal(state.needsAttention, true);
  });

  it("vanished while the transport was down is cannot tell", () => {
    const state = derive({
      lastDeparture: departure({ corroboration: "transport-down" }),
    });
    assert.equal(state.phase, "cannot-tell");
  });

  it("transport-down loses to a proven offline presence", () => {
    // Presence rides the agent's own relay socket, so a cold presence beats
    // the observer-transport reading: it names what happened.
    const state = derive({
      lastDeparture: departure({ corroboration: "transport-down" }),
      presence: "offline",
      presenceLoaded: true,
    });
    assert.equal(state.phase, "went-offline");
  });

  it("vanished with a live presence heartbeat reads as stalled", () => {
    // The agent's own presence kept arriving while its telemetry did not, so
    // the silence is isolated to this agent: stuck, not gone.
    const state = derive({
      lastDeparture: departure(),
      presence: "online",
      presenceLoaded: true,
    });
    assert.equal(state.phase, "stalled");
    assert.equal(state.label, "Not responding");
    assert.equal(
      state.detail,
      "This agent is still running but stopped reporting in the middle of a task.",
    );
    assert.equal(state.sinceAt, NOW - 300_000);
    assert.equal(state.tone, "warning");
    assert.equal(state.needsAttention, true);
    assert.deepEqual(state.channels, []);
  });

  it("vanished corroborated by another agent's frames reads as stalled", () => {
    const state = derive({
      lastDeparture: departure({ corroboration: "confirmed" }),
    });
    assert.equal(state.phase, "stalled");
  });

  it("stalled detail says only that reporting stopped for an agent Colony does not run", () => {
    const state = derive({
      lastDeparture: departure({ corroboration: "confirmed" }),
      process: "unknown",
    });
    assert.equal(
      state.detail,
      "This agent stopped reporting in the middle of a task.",
    );
  });

  it("a cold presence reads as went offline ahead of corroboration", () => {
    const state = derive({
      lastDeparture: departure({ corroboration: "confirmed" }),
      presence: "offline",
      presenceLoaded: true,
    });
    assert.equal(state.phase, "went-offline");
    assert.equal(state.label, "Went offline");
    assert.equal(
      state.detail,
      "This agent disconnected while it was still working.",
    );
  });
});

describe("deriveAgentLivenessState: process axis", () => {
  it("needs-setup outranks even a live turn", () => {
    const state = derive({
      process: "needs-setup",
      liveTurns: [sample()],
    });
    assert.equal(state.phase, "needs-setup");
    assert.equal(state.label, "Needs setup on this device");
    assert.equal(state.needsAttention, true);
  });

  it("a stopped process outranks an unresolved silence", () => {
    // A crash renders honestly through turn_error / agent_panic elsewhere;
    // relabelling it a stall here would be a second verdict for one event.
    const state = derive({
      process: "stopped",
      lastDeparture: departure({ corroboration: "confirmed" }),
    });
    assert.equal(state.phase, "unavailable");
    assert.equal(state.label, "Stopped");
  });

  it("a failed process outranks an unresolved silence", () => {
    const state = derive({
      process: "failed",
      lastDeparture: departure({ corroboration: "confirmed" }),
    });
    assert.equal(state.phase, "unavailable");
    assert.equal(state.label, "Unavailable");
    assert.equal(state.needsAttention, true);
  });

  it("an ended departure under a waking process reads as starting up", () => {
    const state = derive({
      process: "waking",
      lastDeparture: departure({ reason: "ended" }),
    });
    assert.equal(state.phase, "waking");
    assert.equal(state.label, "Starting up");
    assert.equal(state.sinceAt, null);
  });

  it("never had a turn: a ready process with no history reads as Ready", () => {
    const state = derive({ liveTurns: [], lastDeparture: null });
    assert.equal(state.phase, "idle");
    assert.equal(state.label, "Ready");
    assert.equal(state.sinceAt, null);
    assert.equal(state.sinceKind, null);
    assert.equal(state.needsAttention, false);
  });

  it("never had a turn: an agent Colony does not run reads as Idle", () => {
    const state = derive({ process: "unknown" });
    assert.equal(state.phase, "idle");
    assert.equal(state.label, "Idle");
    assert.equal(state.sinceAt, null);
  });
});

describe("formatLastActive", () => {
  it("never shows seconds", () => {
    assert.equal(formatLastActive(0), "just now");
    assert.equal(formatLastActive(59_000), "just now");
  });

  it("renders singular and plural minutes", () => {
    assert.equal(formatLastActive(60_000), "1 minute ago");
    assert.equal(formatLastActive(2 * 60_000), "2 minutes ago");
  });

  it("renders singular and plural hours and days", () => {
    assert.equal(formatLastActive(60 * 60_000), "1 hour ago");
    assert.equal(formatLastActive(90 * 60_000), "1 hour ago");
    assert.equal(formatLastActive(2 * 60 * 60_000), "2 hours ago");
    assert.equal(formatLastActive(24 * 60 * 60_000), "1 day ago");
    assert.equal(formatLastActive(48 * 60 * 60_000), "2 days ago");
  });
});

describe("describeAgentLiveness", () => {
  it("returns the label alone when there is no anchor", () => {
    const state = derive({ liveTurns: [], lastDeparture: null });
    assert.equal(describeAgentLiveness(state, NOW), "Ready");
  });

  it("returns the label alone while working", () => {
    const state = derive({ liveTurns: [sample()] });
    assert.equal(describeAgentLiveness(state, NOW), "Working");
  });

  it("reads the anchor aloud for past-tense phases", () => {
    const state = derive({
      lastDeparture: departure({ corroboration: "confirmed" }),
    });
    assert.equal(
      describeAgentLiveness(state, NOW),
      "Not responding · last active 5 minutes ago",
    );
  });
});

describe("agentLivenessLedger corroboration", () => {
  beforeEach(() => {
    resetAgentLivenessLedger();
  });

  it("classifies transport-down when the observer subscription is closed", () => {
    setObserverTransportOpen(false);
    recordTurnDeparture(AGENT, {
      turnId: "t1",
      channelId: "c1",
      reason: "vanished",
      lastFrameAt: NOW - 300_000,
      lastOutputAt: null,
      departedAt: NOW,
      terminalKind: null,
    });
    assert.equal(getLastTurnDeparture(AGENT).corroboration, "transport-down");
  });

  it("classifies confirmed when another agent framed after this one went silent", () => {
    setObserverTransportOpen(true);
    noteObserverFrame(AGENT, NOW - 300_000);
    noteObserverFrame(AGENT_2, NOW - 200_000);
    recordTurnDeparture(AGENT, {
      turnId: "t1",
      channelId: "c1",
      reason: "vanished",
      lastFrameAt: NOW - 300_000,
      lastOutputAt: null,
      departedAt: NOW,
      terminalKind: null,
    });
    assert.equal(getLastTurnDeparture(AGENT).corroboration, "confirmed");
  });

  it("classifies none when nobody else framed after the silence began", () => {
    setObserverTransportOpen(true);
    noteObserverFrame(AGENT, NOW - 300_000);
    noteObserverFrame(AGENT_2, NOW - 400_000);
    recordTurnDeparture(AGENT, {
      turnId: "t1",
      channelId: "c1",
      reason: "vanished",
      lastFrameAt: NOW - 300_000,
      lastOutputAt: null,
      departedAt: NOW,
      terminalKind: null,
    });
    assert.equal(getLastTurnDeparture(AGENT).corroboration, "none");
  });

  it("answers with the most recent departure by departedAt, not array order", () => {
    // A terminal frame for one turn can be recorded after the prune's own
    // record for a different, later turn; "most recent" must follow the clock.
    recordTurnDeparture(AGENT, {
      turnId: "late-turn",
      channelId: "c2",
      reason: "vanished",
      lastFrameAt: NOW - 300_000,
      lastOutputAt: null,
      departedAt: NOW - 60_000,
      terminalKind: null,
      corroboration: "confirmed",
    });
    recordTurnDeparture(AGENT, {
      turnId: "terminal-turn",
      channelId: "c1",
      reason: "ended",
      lastFrameAt: NOW - 400_000,
      lastOutputAt: null,
      departedAt: NOW,
      terminalKind: "turn_completed",
      corroboration: "none",
    });
    const newest = getLastTurnDeparture(AGENT);
    assert.equal(newest.turnId, "terminal-turn");
    assert.equal(newest.reason, "ended");
  });
});

describe("store-driven liveness: frame-gap outage and the prune boundary", () => {
  const EPOCH = Date.parse("2024-01-01T00:00:00Z");
  const at = (ms) => new Date(EPOCH + ms).toISOString();

  let unsubscribe;

  function stateFor(pubkey, overrides = {}) {
    return deriveAgentLivenessState({
      liveTurns: getLiveTurnSamplesForAgent(pubkey),
      lastDeparture: getLastTurnDeparture(pubkey),
      inFlightTool: null,
      presence: undefined,
      presenceLoaded: false,
      process: "ready",
      now: Date.now(),
      ...overrides,
    });
  }

  beforeEach(() => {
    resetActiveAgentTurnsStore();
    mock.timers.enable({ apis: ["setInterval", "Date"], now: EPOCH });
    unsubscribe = subscribeActiveAgentTurns(() => {});
  });

  afterEach(() => {
    unsubscribe();
    mock.timers.reset();
  });

  it("an all-at-once silence holds the turn and renders cannot tell", () => {
    setObserverTransportOpen(true);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({ seq: 1, turnId: "t1", channelId: "c1", timestamp: at(0) }),
    ]);
    // No output ever arrives; liveness pings stop at 10s.
    mock.timers.tick(10_000);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({
        seq: 2,
        kind: "turn_liveness",
        turnId: "t1",
        channelId: "c1",
        timestamp: at(10_000),
      }),
    ]);

    // At 26s of frame silence the stale bound has passed. The pause engaged
    // at 20s (all of this agent's turns stale together), so the turn survives
    // the 25s prune bound and the badge must say it cannot tell.
    mock.timers.tick(26_000);
    const state = stateFor(AGENT);
    assert.equal(
      state.phase,
      "cannot-tell",
      "the outage must not read as work",
    );
    assert.equal(state.label, "No signal");

    // Still held at 100s of silence: the pause is bounded at three minutes.
    mock.timers.tick(74_000);
    assert.equal(stateFor(AGENT).phase, "cannot-tell");
  });

  it("a silent turn with a fresh sibling prunes on schedule and records vanished", () => {
    setObserverTransportOpen(true);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({
        seq: 1,
        turnId: "dead",
        channelId: "c1",
        timestamp: at(0),
      }),
      makeEvent({
        seq: 2,
        turnId: "live",
        channelId: "c2",
        timestamp: at(0),
      }),
    ]);
    // Keep "live" fresh so the pause never engages and "dead" prunes at 25s.
    for (let t = 10_000; t <= 30_000; t += 10_000) {
      mock.timers.tick(10_000);
      syncAgentTurnsFromEvents(AGENT, [
        makeEvent({
          seq: 2 + t / 10_000,
          kind: "turn_liveness",
          turnId: "live",
          channelId: "c2",
          timestamp: at(t),
        }),
      ]);
    }
    mock.timers.tick(5_000);

    const departed = getLastTurnDeparture(AGENT);
    assert.ok(departed, "the prune must write its receipt");
    assert.equal(departed.reason, "vanished");
    assert.equal(departed.turnId, "dead");
    // Nobody else ever framed, so the prune's verdict alone must stay
    // ambiguous rather than claiming a stall.
    assert.equal(departed.corroboration, "none");
    // The fresh sibling keeps the whole agent reading as busy: the vanished
    // receipt exists, but live turns are answered from their own frames.
    assert.equal(stateFor(AGENT).phase, "working");
  });

  it("past the three-minute pause the turn prunes and the departure carries evidence", () => {
    setObserverTransportOpen(true);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({ seq: 1, turnId: "t1", channelId: "c1", timestamp: at(0) }),
    ]);
    // Another agent keeps framing long after this one went silent, proving
    // the frame stream was up while this agent produced nothing.
    syncAgentTurnsFromEvents(AGENT_2, [
      makeEvent({ seq: 1, turnId: "b1", channelId: "b", timestamp: at(0) }),
    ]);
    mock.timers.tick(30_000);
    syncAgentTurnsFromEvents(AGENT_2, [
      makeEvent({
        seq: 2,
        kind: "turn_liveness",
        turnId: "b1",
        channelId: "b",
        timestamp: at(30_000),
      }),
    ]);

    mock.timers.tick(3 * 60_000);
    mock.timers.tick(5_000);

    const departed = getLastTurnDeparture(AGENT);
    assert.ok(departed, "the pause backstop must eventually prune");
    assert.equal(departed.reason, "vanished");
    assert.equal(
      departed.corroboration,
      "confirmed",
      "the other agent's later frames corroborate the stream was alive",
    );
    // Without an independent presence reading the verdict stays a stall
    // only because corroboration is confirmed; the agent is stuck, not gone.
    const state = stateFor(AGENT);
    assert.equal(state.phase, "stalled");
    assert.equal(state.label, "Not responding");
  });

  it("a terminal outcome while quiet renders idle, keeping the stall honest", () => {
    setObserverTransportOpen(true);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({ seq: 1, turnId: "t1", channelId: "c1", timestamp: at(0) }),
    ]);
    // The turn runs quiet for two minutes: liveness, no output.
    for (let t = 10_000; t <= 120_000; t += 10_000) {
      mock.timers.tick(10_000);
      syncAgentTurnsFromEvents(AGENT, [
        makeEvent({
          seq: 1 + t / 10_000,
          kind: "turn_liveness",
          turnId: "t1",
          channelId: "c1",
          timestamp: at(t),
        }),
      ]);
    }
    assert.equal(stateFor(AGENT).phase, "working-quietly");

    // Then the harness reports the outcome: the silence is explained.
    mock.timers.tick(10_000);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({
        seq: 20,
        kind: "turn_error",
        turnId: "t1",
        channelId: "c1",
        timestamp: at(130_000),
      }),
    ]);

    const departed = getLastTurnDeparture(AGENT);
    assert.equal(departed.reason, "ended");
    assert.equal(departed.terminalKind, "turn_error");
    assert.equal(stateFor(AGENT).phase, "idle");
  });

  it("a fresh turn retires a stall the agent already recovered from", () => {
    setObserverTransportOpen(true);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({ seq: 1, turnId: "t1", channelId: "c1", timestamp: at(0) }),
    ]);
    syncAgentTurnsFromEvents(AGENT_2, [
      makeEvent({ seq: 1, turnId: "b1", channelId: "b", timestamp: at(0) }),
    ]);
    mock.timers.tick(30_000);
    syncAgentTurnsFromEvents(AGENT_2, [
      makeEvent({
        seq: 2,
        kind: "turn_liveness",
        turnId: "b1",
        channelId: "b",
        timestamp: at(30_000),
      }),
    ]);
    mock.timers.tick(3 * 60_000);
    mock.timers.tick(5_000);
    assert.equal(stateFor(AGENT).phase, "stalled");

    // The agent starts new work: every prior "it went quiet" record is stale
    // evidence and must not keep a demonstrably working agent flagged.
    mock.timers.tick(10_000);
    syncAgentTurnsFromEvents(AGENT, [
      makeEvent({
        seq: 2,
        turnId: "t2",
        channelId: "c1",
        timestamp: at(230_000),
      }),
    ]);
    assert.equal(getLastTurnDeparture(AGENT), null);
    assert.equal(stateFor(AGENT).phase, "working");
  });
});
