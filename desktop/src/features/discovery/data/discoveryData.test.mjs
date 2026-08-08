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

  assert.equal(industries.length, 34);
  assert.equal(industries[0].slug, "fashion-apparel");
  assert.ok(industries[0].imageKey);

  const verticals = await source.getVerticals("automotive");
  assert.equal(verticals.length, 11);
  assert.deepEqual(
    verticals.map(({ id, name, industryId }) => ({ id, name, industryId })),
    [
      "Auto Manufacturing",
      "Auto Parts Stores",
      "Auto Parts Suppliers",
      "Auto Repair",
      "Car Dealerships",
      "Car Rentals",
      "Engine Repair Garages",
      "Fleet & Vehicle Leasing Services",
      "Panel Beaters",
      "Petrol Stations",
      "Tyre Services",
    ].map((name, index) => ({
      id: [
        "auto-manufacturing",
        "auto-parts-stores",
        "auto-parts-suppliers",
        "auto-repair",
        "car-dealerships",
        "car-rentals",
        "engine-repair-garages",
        "fleet-vehicle-leasing-services",
        "panel-beaters",
        "petrol-stations",
        "tyre-services",
      ][index],
      name,
      industryId: "automotive",
    })),
  );

  const vertical = await source.getVertical("automotive", "auto-repair");
  assert.equal(vertical.name, "Auto Repair");
  assert.equal(vertical.campaigns.length, 1);
  assert.equal(vertical.campaigns[0].id, "auto-repair-johannesburg");

  const leads = await source.getLeads({
    scope: "campaign",
    campaignId: "auto-repair-johannesburg",
  });
  const campaign = await source.getCampaign("auto-repair-johannesburg");
  assert.deepEqual(campaign.metrics, {
    companiesFound: leads.total,
    contactsFound: leads.leads.reduce(
      (total, lead) => total + lead.contacts,
      0,
    ),
    emailsFound: leads.leads.filter((lead) => Boolean(lead.email)).length,
    missingWebsites: leads.leads.filter((lead) => !lead.website).length,
  });

  const professionalServices = await source.getVerticals(
    "professional-services",
  );
  assert.equal(professionalServices.length, 18);
  const accounting = await source.getVertical(
    "professional-services",
    "accounting-financial-advisory",
  );
  assert.equal(accounting.campaigns[0].leadCount, 308);
  const legacyAccounting = await source.getVertical(
    "professional-services",
    "accounting-practices",
  );
  assert.equal(legacyAccounting.id, "accounting-financial-advisory");
});

test("every advertised business industry exposes the complete SalesTeams taxonomy", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const industries = await source.getIndustries();
  const verticalGroups = await Promise.all(
    industries.map(async (industry) => ({
      industry,
      verticals: await source.getVerticals(industry.id),
    })),
  );

  assert.equal(industries.length, 34);
  assert.equal(
    verticalGroups.reduce(
      (total, { verticals }) => total + verticals.length,
      0,
    ),
    531,
  );

  for (const { industry, verticals } of verticalGroups) {
    assert.equal(
      verticals.length,
      industry.verticalCount,
      `${industry.name} vertical count`,
    );
    assert.ok(verticals.length > 0, `${industry.name} has verticals`);
    assert.equal(
      new Set(verticals.map(({ id }) => id)).size,
      verticals.length,
      `${industry.name} vertical IDs are unique`,
    );
  }

  const realEstate = verticalGroups.find(
    ({ industry }) => industry.id === "real-estate",
  );
  assert.ok(realEstate);
  assert.equal(realEstate.verticals.length, 14);
  assert.ok(
    realEstate.verticals.some(
      ({ name }) =>
        name === "Residential Real Estate (Estate Agents & Property Sales)",
    ),
  );
  assert.ok(
    realEstate.verticals.some(
      ({ name }) =>
        name === "Commercial Real Estate (Office & Retail Properties)",
    ),
  );
  assert.ok(
    realEstate.verticals.some(({ name }) => name === "Property Development"),
  );
});

test("fixture lead counts match the taxonomy cards", async () => {
  const source = createFixtureDiscoveryDataSource();
  const [industries, counts] = await Promise.all([
    source.getIndustries(),
    source.getLeadCounts(),
  ]);
  assert.equal(
    counts.total,
    industries.reduce((sum, item) => sum + item.leadCount, 0),
  );
  for (const industry of industries) {
    const row = counts.industries.find(
      (candidate) => candidate.industryId === industry.id,
    );
    assert.equal(row?.count, industry.leadCount);
  }
  assert.ok(counts.verticals.length > 0);
});

test("fixture lead detail round-trips an edit and defaults status to candidate", async () => {
  const source = createFixtureDiscoveryDataSource();
  const page = await source.getLeads({
    scope: "global",
    status: "candidate",
    page: 1,
    pageSize: 1,
  });
  const leadId = page.leads[0].id;
  const detail = await source.getLead(leadId);
  assert.equal(detail.status, "candidate");

  const updated = await source.updateLead(leadId, {
    status: "accepted",
    notes: "Warm intro",
    score: 82,
    owner: "Chief of Staff",
  });
  assert.equal(updated.status, "accepted");
  assert.equal(updated.notes, "Warm intro");
  assert.equal(updated.score, 82);
  assert.equal(updated.owner, "Chief of Staff");
  assert.ok(updated.updatedAt);
});

test("fixture updateLead wipes omitted fields the way the relay does", async () => {
  const source = createFixtureDiscoveryDataSource();
  const page = await source.getLeads({ scope: "global", page: 1, pageSize: 1 });
  const leadId = page.leads[0].id;

  const seeded = await source.updateLead(leadId, {
    status: "accepted",
    website: "https://seed.example",
    email: "seed@example.com",
    notes: "Warm intro",
    owner: "Chief of Staff",
    score: 82,
  });
  assert.equal(seeded.email, "seed@example.com");
  assert.equal(seeded.notes, "Warm intro");

  // A partial write is destructive on the relay, so it must be destructive
  // here too. If this ever preserves the omitted fields, demo mode and every
  // Playwright edit case go blind to the data-loss hazard and only the wire
  // test in RelayDiscoveryDataSource.test.mjs still catches it.
  const partial = await source.updateLead(leadId, {
    website: "https://changed.example",
  });
  assert.equal(partial.website, "https://changed.example");
  assert.equal(partial.email, undefined, "an omitted email must be cleared");
  assert.equal(partial.notes, undefined, "omitted notes must be cleared");
  assert.equal(partial.owner, undefined, "an omitted owner must be cleared");
  assert.equal(
    partial.status,
    "accepted",
    "status is the one field the relay carries forward",
  );
});

test("fixture source returns the complete SalesTeams people hierarchy", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const fields = await source.getFields();
  assert.equal(fields.length, 18);
  assert.equal(
    fields.reduce((total, field) => total + field.roleCount, 0),
    96,
  );

  const roles = await source.getRoles("marketing");
  assert.equal(roles.length, 7);
  assert.equal(roles[0].name, "Marketing Director");

  const role = await source.getRole("marketing", "marketing-director");
  assert.equal(role.campaigns.length, 1);
  assert.equal(role.campaigns[0].targetType, "individual");

  const people = await source.getLeads({
    scope: "campaign",
    campaignId: "marketing-directors-united-states",
    targetType: "individual",
  });
  assert.equal(people.total, 8);
  assert.ok(people.leads.every((lead) => lead.entityType === "person"));
  assert.ok(people.leads.every((lead) => Boolean(lead.personName)));

  const campaign = await source.getCampaign(
    "marketing-directors-united-states",
  );
  assert.deepEqual(campaign.sourceConfig.order, [
    "linkedin_company_search",
    "brave_search",
    "exa_search",
  ]);
});

test("outreach and conversations persist through the fixture data source", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const campaignId = "marketing-directors-united-states";
  const outreach = await source.getOutreach(campaignId);
  assert.equal(outreach.length, 5);
  const updated = await source.updateOutreachStatus(
    campaignId,
    outreach.at(-1).id,
    "Scheduled",
  );
  assert.equal(updated.status, "Scheduled");
  assert.equal(
    (await source.getOutreach(campaignId)).at(-1).status,
    "Scheduled",
  );

  const conversations = await source.getConversations(campaignId);
  const conversation = conversations[0];
  await source.markConversationRead(campaignId, conversation.id);
  const replied = await source.sendConversationReply(
    campaignId,
    conversation.id,
    "Here are the examples.",
  );
  assert.equal(replied.unread, false);
  assert.equal(replied.messages.at(-1).body, "Here are the examples.");
});

test("entitlement is provider-neutral and does not invent a price", async () => {
  const locked = createFixtureDiscoveryDataSource({
    entitlement: "not_entitled",
  });
  const entitlement = await locked.getEntitlement();

  assert.deepEqual(entitlement, {
    feature: "discovery_engine",
    state: "not_entitled",
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

test("waterfall target fixture expands deterministic leads for larger targets", async () => {
  const source = createFixtureDiscoveryDataSource({
    scenario: "waterfall-target",
  });
  const campaign = await source.createCampaign({
    name: "Twenty lead waterfall",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Johannesburg",
    target: 20,
  });
  const events = [];
  for await (const event of source.startDiscovery(campaign.id)) {
    events.push(event);
  }
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "session_completed");
  assert.equal(terminal?.targetReached, true);
  assert.equal(terminal?.run.stored, 20);
  assert.equal(terminal?.run.discovered, 20);
  assert.equal(
    events.filter((event) => event.type === "lead_stored").length,
    20,
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

test("starting discovery after a partial run resets the active run boundary", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "partial" });
  for await (const _event of source.startDiscovery(
    "auto-repair-johannesburg",
  )) {
    // Drain the partial fixture.
  }
  const stream = source.startDiscovery("auto-repair-johannesburg");
  await source.cancelDiscovery("auto-repair-johannesburg");
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.at(-1)?.type, "session_cancelled");
  assert.equal(
    (await source.getCampaign("auto-repair-johannesburg")).status,
    "cancelled",
  );
});

test("updating source config invalidates an active stream before resetting its run", async () => {
  const source = createFixtureDiscoveryDataSource({ scenario: "concurrent" });
  const iterator = source
    .startDiscovery("auto-repair-johannesburg")
    [Symbol.asyncIterator]();
  await iterator.next();
  await source.updateSourceConfig("auto-repair-johannesburg", {
    mode: "waterfall",
    order: ["brave_search"],
  });
  const stale = await iterator.next();
  assert.equal(stale.done, true);
  const campaign = await source.getCampaign("auto-repair-johannesburg");
  assert.equal(campaign.status, "ready");
  assert.deepEqual(campaign.sourceConfig.order, ["brave_search"]);
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
  const detail = await source.getCampaign(campaign.id);
  assert.equal(detail.metrics.companiesFound, after.total);
  assert.equal(
    detail.metrics.contactsFound,
    after.leads.reduce((total, lead) => total + lead.contacts, 0),
  );
  assert.equal(
    detail.metrics.emailsFound,
    after.leads.filter((lead) => Boolean(lead.email)).length,
  );
  assert.equal(
    detail.metrics.missingWebsites,
    after.leads.filter((lead) => !lead.website).length,
  );
});

test("repeated discovery emits duplicates without inflating campaign leads", async () => {
  const source = createFixtureDiscoveryDataSource({
    scenario: "waterfall-target",
  });
  const campaign = await source.createCampaign({
    name: "Repeatable fixture campaign",
    industryId: "automotive",
    verticalId: "auto-repair",
    location: "Johannesburg",
    target: 2,
  });
  for await (const _event of source.startDiscovery(campaign.id)) {
    // First run stores two deterministic leads.
  }
  const first = await source.getLeads({
    scope: "campaign",
    campaignId: campaign.id,
  });
  const secondEvents = [];
  for await (const event of source.startDiscovery(campaign.id)) {
    secondEvents.push(event);
  }
  const second = await source.getLeads({
    scope: "campaign",
    campaignId: campaign.id,
  });
  const terminal = secondEvents.at(-1);
  assert.equal(first.total, 2);
  assert.equal(second.total, first.total);
  assert.equal(
    secondEvents.filter((event) => event.type === "lead_duplicate").length,
    2,
  );
  assert.equal(terminal?.run.stored, 0);
  assert.equal(terminal?.run.duplicates, 2);
  assert.equal(terminal?.targetReached, false);
});

test("pipeline columns mirror the fixture's status-filtered totals", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const columns = await source.getPipelineColumns();
  assert.equal(columns.length, 6);
  for (const column of columns) {
    const page = await source.getLeads({
      scope: "global",
      status: column.status,
      page: 1,
      pageSize: 100,
    });
    assert.equal(
      column.total,
      page.total,
      `${column.status} total must come from the status-filtered page, not the loaded array`,
    );
    assert.equal(column.leads.length, Math.min(page.total, 100));
    assert.ok(
      column.leads.every((lead) => lead.status === column.status),
      `${column.status} column must only hold leads of that status`,
    );
  }
});

test("fixture updateLead enforces the relay transition matrix with its wording", async () => {
  const source = createFixtureDiscoveryDataSource({ entitlement: "entitled" });
  const page = await source.getLeads({
    scope: "global",
    status: "candidate",
    page: 1,
    pageSize: 1,
  });
  const leadId = page.leads[0].id;
  const accepted = await source.updateLead(leadId, { status: "accepted" });
  assert.equal(accepted.status, "accepted");
  const disqualified = await source.updateLead(leadId, {
    status: "disqualified",
  });
  assert.equal(disqualified.status, "disqualified");

  await assert.rejects(
    source.updateLead(leadId, { status: "accepted" }),
    {
      message:
        "invalid: Lead status transition Disqualified -> Accepted is not allowed",
    },
    "a move out of a terminal status must refuse with the relay's wording",
  );
  const notesOnly = await source.updateLead(leadId, { notes: "Still warm" });
  assert.equal(notesOnly.status, "disqualified");
  assert.equal(notesOnly.notes, "Still warm");
});
