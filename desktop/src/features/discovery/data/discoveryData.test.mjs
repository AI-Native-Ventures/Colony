import assert from "node:assert/strict";
import test from "node:test";

import { canStartDiscovery } from "../entitlement.ts";
import {
  DEFAULT_SOURCE_CONFIG,
  isValidSourceConfig,
  resolveSourceConfig,
  toggleSource,
} from "../sourceConfig.ts";
import { createFixtureDiscoveryDataSource } from "./FixtureDiscoveryDataSource.ts";

test("fixture source returns the SalesTeams-shaped discovery hierarchy", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const industries = await source.getIndustries();

  assert.equal(industries.length, 4);
  assert.equal(industries[0].slug, "automotive");
  assert.ok(industries[0].imageKey);

  const vertical = await source.getVertical("automotive", "auto-repair");
  assert.equal(vertical.name, "Auto Repair");
  assert.equal(vertical.campaigns.length, 1);
  assert.equal(vertical.campaigns[0].id, "auto-repair-johannesburg");
});

test("entitlement is provider-neutral and does not invent a price", async () => {
  const locked = createFixtureDiscoveryDataSource({
    entitlement: "not_entitled",
  });
  const entitlement = await locked.getEntitlement();

  assert.deepEqual(entitlement, {
    feature: "discovery_engine",
    state: "not_entitled",
    planName: "LAKA",
  });
  assert.equal(canStartDiscovery(entitlement), false);
  assert.equal(
    canStartDiscovery({ feature: "discovery_engine", state: "entitled" }),
    true,
  );
});

test("source configuration has a safe non-empty waterfall default", () => {
  assert.equal(DEFAULT_SOURCE_CONFIG.mode, "waterfall");
  assert.ok(DEFAULT_SOURCE_CONFIG.order.length > 0);
  assert.equal(isValidSourceConfig(DEFAULT_SOURCE_CONFIG), true);
  assert.deepEqual(
    resolveSourceConfig({ mode: "waterfall", order: [] }),
    DEFAULT_SOURCE_CONFIG,
  );
  assert.deepEqual(
    toggleSource({ mode: "waterfall", order: ["google_maps"] }, "directories"),
    { mode: "waterfall", order: ["google_maps", "directories"] },
  );
});

test("waterfall fixture emits ordered source states and target completion", async () => {
  const source = createFixtureDiscoveryDataSource({
    scenario: "waterfall-target",
  });
  const events = [];

  for await (const event of source.startDiscovery("auto-repair-johannesburg")) {
    events.push(event);
  }

  assert.deepEqual(
    events
      .filter((event) => event.type === "source_started")
      .map((event) => event.source),
    ["google_maps"],
  );
  assert.equal(events.at(-1)?.type, "session_completed");
  assert.equal(events.at(-1)?.targetReached, true);
  assert.equal(
    events.filter((event) =>
      ["session_completed", "session_cancelled", "session_failed"].includes(
        event.type,
      ),
    ).length,
    1,
  );
});

test("fixture scenarios cover fallback, skipped, partial, cancelled, and failed terminals", async () => {
  const scenarios = [
    ["fallback", "session_completed"],
    ["skipped-source", "session_completed"],
    ["partial", "session_completed"],
    ["cancelled", "session_cancelled"],
    ["failed", "session_failed"],
  ];

  for (const [scenario, terminalType] of scenarios) {
    const source = createFixtureDiscoveryDataSource({ scenario });
    const events = [];
    for await (const event of source.startDiscovery(
      "auto-repair-johannesburg",
    )) {
      events.push(event);
    }
    assert.equal(events.at(-1)?.type, terminalType, scenario);
    assert.ok(
      events.some((event) => event.type.startsWith("source_")),
      scenario,
    );
    assert.equal(
      events.filter((event) =>
        ["session_completed", "session_cancelled", "session_failed"].includes(
          event.type,
        ),
      ).length,
      1,
      scenario,
    );
  }
});

test("cancelDiscovery interrupts a running stream on a microtask boundary", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "concurrent" });
  const iterator = source
    .startDiscovery("auto-repair-johannesburg")
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);

  await source.cancelDiscovery("auto-repair-johannesburg");
  const remaining = [];
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    remaining.push(event);
  }

  assert.equal(remaining.at(-1)?.type, "session_cancelled");
  assert.equal(
    remaining.filter((event) =>
      ["session_completed", "session_cancelled", "session_failed"].includes(
        event.type,
      ),
    ).length,
    1,
  );
  const campaign = await source.getCampaign("auto-repair-johannesburg");
  assert.equal(campaign.run?.status, "cancelled");
});
