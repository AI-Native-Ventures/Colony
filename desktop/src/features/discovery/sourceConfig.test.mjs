import assert from "node:assert/strict";
import test from "node:test";

import { canStartDiscovery } from "./entitlement.ts";
import {
  canReorderSources,
  DEFAULT_SOURCE_CONFIG,
  DISCOVERY_SOURCES,
  isValidSourceConfig,
  moveSource,
  resolveSourceConfig,
  toggleSource,
} from "./sourceConfig.ts";
import { createFixtureDiscoveryDataSource } from "./data/FixtureDiscoveryDataSource.ts";

test("waterfall toggles preserve enabled order and prevent disabling the last source", () => {
  const original = {
    mode: "waterfall",
    order: ["google_maps", "brave_search"],
  };
  assert.deepEqual(toggleSource(original, "google_maps"), {
    mode: "waterfall",
    order: ["brave_search"],
  });
  assert.deepEqual(toggleSource(original, "directories"), {
    mode: "waterfall",
    order: ["google_maps", "brave_search", "directories"],
  });
  assert.deepEqual(
    toggleSource({ mode: "waterfall", order: ["google_maps"] }, "google_maps"),
    {
      mode: "waterfall",
      order: ["google_maps"],
    },
  );
});

test("waterfall reorders enabled sources, while concurrent mode disables ordering", () => {
  const waterfall = {
    mode: "waterfall",
    order: ["google_maps", "brave_search", "directories"],
  };
  assert.equal(canReorderSources(waterfall), true);
  assert.deepEqual(moveSource(waterfall, "directories", "google_maps").order, [
    "directories",
    "google_maps",
    "brave_search",
  ]);

  const concurrent = { ...waterfall, mode: "concurrent" };
  assert.equal(canReorderSources(concurrent), false);
  assert.deepEqual(
    moveSource(concurrent, "directories", "google_maps"),
    concurrent,
  );
  assert.deepEqual(toggleSource(concurrent, "exa_search").order, [
    "google_maps",
    "brave_search",
    "directories",
    "exa_search",
  ]);
});

test("invalid or duplicate configs resolve to a safe non-empty default", () => {
  assert.equal(isValidSourceConfig({ mode: "waterfall", order: [] }), false);
  assert.equal(
    isValidSourceConfig({
      mode: "waterfall",
      order: ["google_maps", "google_maps"],
    }),
    false,
  );
  assert.deepEqual(
    resolveSourceConfig({ mode: "waterfall", order: [] }),
    DEFAULT_SOURCE_CONFIG,
  );
  assert.deepEqual(
    resolveSourceConfig({ mode: "waterfall", order: ["unknown"] }),
    DEFAULT_SOURCE_CONFIG,
  );
});

test("all audited source labels have a stable registry key", () => {
  assert.equal(DISCOVERY_SOURCES.length, 7);
  assert.deepEqual(
    DISCOVERY_SOURCES.map(({ key }) => key),
    [
      "google_maps",
      "dataforseo",
      "brave_search",
      "exa_search",
      "openstreetmap",
      "directories",
      "linkedin_company_search",
    ],
  );
});

test("fixture source config updates immediately without a provider", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const updated = await source.updateSourceConfig("auto-repair-johannesburg", {
    mode: "concurrent",
    order: ["brave_search", "google_maps"],
  });
  assert.equal(updated.sourceConfig.mode, "concurrent");
  assert.deepEqual(updated.sourceConfig.order, ["brave_search", "google_maps"]);
  assert.deepEqual(
    (await source.getCampaign("auto-repair-johannesburg")).sourceConfig.order,
    ["brave_search", "google_maps"],
  );
});

test("entitlement action states distinguish entitled from loading and errors", () => {
  assert.equal(canStartDiscovery({ state: "entitled" }), true);
  assert.equal(canStartDiscovery({ state: "loading" }), false);
  assert.equal(canStartDiscovery({ state: "error" }), false);
  assert.equal(canStartDiscovery({ state: "not_entitled" }), false);
});
