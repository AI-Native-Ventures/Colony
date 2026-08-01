import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource.ts";
import {
  createDiscoveryRunState,
  discoveryRunReducer,
} from "../useDiscoveryRun.ts";

async function fixtureState(scenario) {
  const source = createFixtureDiscoveryDataSource({ scenario });
  const campaign = await source.getCampaign("auto-repair-johannesburg");
  let state = createDiscoveryRunState(campaign.run);
  const events = [];
  for await (const event of source.startDiscovery(campaign.id)) {
    events.push(event);
    state = discoveryRunReducer(state, { type: "event", event });
  }
  return { events, state };
}

test("reducer preserves ordered timeline and maps source metrics", async () => {
  const { events, state } = await fixtureState("concurrent");
  assert.equal(state.timeline.length, events.length);
  assert.deepEqual(
    state.timeline.map((item) => item.type),
    events.map((event) => event.type),
  );
  assert.equal(state.run.status, "partial");
  assert.equal(state.run.phase, "completed");
  assert.ok(
    state.run.sourceMetrics.some((metric) => metric.status === "exhausted"),
  );
  assert.equal(state.run.stored, 3);
});

test("target reached completes with a clamped completion run", async () => {
  const { state } = await fixtureState("waterfall-target");
  assert.equal(state.run.targetReached, true);
  assert.equal(state.run.status, "completed");
  assert.equal(state.run.completion, 100);
  assert.ok(state.timeline.some((item) => item.type === "target_reached"));
});

test("fallback, skipped, partial, cancelled, and failed runs retain evidence", async () => {
  const expected = [
    ["fallback", "completed", "fallback_activated"],
    ["skipped-source", "completed", "source_skipped"],
    ["partial", "partial", "lead_rejected"],
    ["cancelled", "cancelled", "session_cancelled"],
    ["failed", "failed", "session_failed"],
  ];

  for (const [scenario, status, evidence] of expected) {
    const { state } = await fixtureState(scenario);
    assert.equal(state.run.status, status, scenario);
    assert.ok(
      state.timeline.some((item) => item.type === evidence),
      scenario,
    );
    assert.equal(state.terminal, true, scenario);
  }
});

test("events after terminal state are ignored", async () => {
  const { state, events } = await fixtureState("failed");
  const before = state;
  const lateEvent = events[0];
  const after = discoveryRunReducer(state, { type: "event", event: lateEvent });
  assert.strictEqual(after, before);
  assert.equal(after.timeline.length, before.timeline.length);
  assert.equal(after.run.status, "failed");
});
