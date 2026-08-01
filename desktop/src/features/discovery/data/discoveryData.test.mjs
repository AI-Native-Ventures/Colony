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
  assert.deepEqual(
    toggleSource({ mode: "waterfall", order: ["google_maps"] }, "google_maps"),
    { mode: "waterfall", order: ["google_maps"] },
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
  const metricTotals = events.at(-1)?.run.sourceMetrics.reduce(
    (totals, metric) => ({
      discovered: totals.discovered + metric.discovered,
      stored: totals.stored + metric.stored,
      rejected: totals.rejected + metric.rejected,
      duplicates: totals.duplicates + metric.duplicates,
    }),
    { discovered: 0, stored: 0, rejected: 0, duplicates: 0 },
  );
  assert.deepEqual(metricTotals, {
    discovered: events.at(-1)?.run.discovered,
    stored: events.at(-1)?.run.stored,
    rejected: events.at(-1)?.run.rejected,
    duplicates: events.at(-1)?.run.duplicates,
  });
  assert.equal(
    events.filter((event) => event.type === "lead_stored").length,
    events.at(-1)?.run.stored,
  );
  assert.equal(
    events.filter((event) =>
      ["session_completed", "session_cancelled", "session_failed"].includes(
        event.type,
      ),
    ).length,
    1,
  );
});

test("fixture stream represents rejected leads and exhausted sources", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "partial" });
  const events = [];
  for await (const event of source.startDiscovery("auto-repair-johannesburg")) {
    events.push(event);
  }
  assert.ok(events.some((event) => event.type === "lead_rejected"));
  assert.ok(events.some((event) => event.type === "source_exhausted"));
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

test("cancel before the first next emits cancellation without applying session start", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "concurrent" });
  const stream = source.startDiscovery("auto-repair-johannesburg");
  await source.cancelDiscovery("auto-repair-johannesburg");
  const events = [];
  for await (const event of stream) events.push(event);

  assert.equal(events[0]?.type, "session_cancelled");
  assert.equal(
    events.some((event) => event.type === "session_started"),
    false,
  );
});

test("cancel after a terminal run is a no-op", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "partial" });
  for await (const _event of source.startDiscovery(
    "auto-repair-johannesburg",
  )) {
    // Drain the deterministic fixture stream.
  }
  const before = await source.getCampaign("auto-repair-johannesburg");
  await source.cancelDiscovery("auto-repair-johannesburg");
  const after = await source.getCampaign("auto-repair-johannesburg");
  assert.equal(before.status, "partial");
  assert.equal(after.status, "partial");
  assert.equal(after.run?.status, "partial");
});

test("createCampaign rejects non-finite and non-positive targets", async () => {
  const source = createFixtureDiscoveryDataSource();
  const base = {
    name: "Invalid target campaign",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Johannesburg",
  };
  for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      source.createCampaign({ ...base, target }),
      /target must/i,
    );
  }
});

test("stored fixture leads persist in the campaign read model", async () => {
  const source = createFixtureDiscoveryDataSource({
    scenario: "waterfall-target",
  });
  const campaign = await source.createCampaign({
    name: "New fixture campaign",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Johannesburg",
    target: 2,
  });
  const before = await source.getLeads({
    scope: "campaign",
    campaignId: campaign.id,
  });
  for await (const _event of source.startDiscovery(campaign.id)) {
    // Drain the deterministic fixture stream.
  }
  const after = await source.getLeads({
    scope: "campaign",
    campaignId: campaign.id,
  });
  assert.equal(before.total, 0);
  assert.ok(after.total > before.total);
  assert.ok(
    after.leads.every((lead) => lead.campaignIds.includes(campaign.id)),
  );
});
