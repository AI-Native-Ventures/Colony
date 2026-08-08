import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource.ts";
import {
  EMPTY_LEAD_FILTERS,
  filterLeads,
  leadOwner,
  resolveLeadMode,
} from "./LeadFilters.tsx";
import { LEAD_TABLE_COLUMNS } from "./LeadFilters.tsx";
import { leadTableRows } from "./LeadTable.tsx";
import { campaignLeadStats, globalLeadStats } from "./LeadsStats.tsx";

async function fixtureLeads(scope) {
  const source = createFixtureDiscoveryDataSource();
  const page = await source.getLeads({
    scope,
    campaignId: scope === "campaign" ? "auto-repair-johannesburg" : undefined,
    page: 1,
    pageSize: 500,
  });
  return scope === "global"
    ? page.leads.filter((lead) => !lead.id.startsWith("accounting-practice-"))
    : page.leads;
}

test("lead mode preserves the companies/people switch", () => {
  assert.equal(resolveLeadMode("companies"), "companies");
  assert.equal(resolveLeadMode("people"), "people");
  assert.equal(resolveLeadMode("unexpected"), "companies");
});

test("text, location, channel, quality, and owner filters compose", async () => {
  const leads = await fixtureLeads("global");
  const ownedLead = { ...leads[0], owner: "Chief of Staff" };
  const withOwner = [ownedLead, ...leads.slice(1)];

  assert.deepEqual(
    filterLeads(withOwner, { ...EMPTY_LEAD_FILTERS, search: "rosebank" }).map(
      (lead) => lead.id,
    ),
    ["lead-001"],
  );
  assert.deepEqual(
    filterLeads(withOwner, {
      ...EMPTY_LEAD_FILTERS,
      location: "Pretoria, Gauteng",
    }).map((lead) => lead.id),
    ["lead-011"],
  );
  // Status is relay-owned: the workspace fetches the selected status from the
  // relay and the client-side filter never narrows by it again.
  assert.deepEqual(
    filterLeads(withOwner, {
      ...EMPTY_LEAD_FILTERS,
      status: "qualified",
    }).map((lead) => lead.id),
    withOwner.map((lead) => lead.id),
  );
  assert.deepEqual(
    filterLeads(withOwner, {
      ...EMPTY_LEAD_FILTERS,
      channel: "google_maps",
    }).map((lead) => lead.id),
    ["lead-001", "lead-006", "lead-011"],
  );
  assert.deepEqual(
    filterLeads(withOwner, {
      ...EMPTY_LEAD_FILTERS,
      quality: "needs-review",
    }).map((lead) => lead.id),
    [
      "lead-004",
      "lead-005",
      "lead-006",
      "lead-007",
      "lead-008",
      "lead-009",
      "lead-010",
      "lead-011",
      "lead-012",
    ],
  );
  assert.deepEqual(
    filterLeads(withOwner, {
      ...EMPTY_LEAD_FILTERS,
      owner: "Chief of Staff",
    }).map((lead) => lead.id),
    ["lead-001"],
  );
  assert.equal(leadOwner(leads[1]), "Unassigned");
});

test("lead rows preserve adapter order and expose the supplied columns", async () => {
  const campaignLeads = await fixtureLeads("campaign");
  const rows = leadTableRows(campaignLeads);
  assert.deepEqual(
    rows.map(({ lead }) => lead.id),
    campaignLeads.map((lead) => lead.id),
  );
  assert.deepEqual(Object.keys(rows[0].columns), [
    "company",
    "location",
    "source",
    "contacts",
    "owner-score",
    "added",
    "status",
  ]);
  assert.deepEqual(LEAD_TABLE_COLUMNS, [
    "company",
    "location",
    "source",
    "contacts",
    "owner-score",
    "added",
    "status",
  ]);
});

test("campaign and global stats are derived from supplied lead data", async () => {
  const campaignLeads = await fixtureLeads("campaign");
  const globalLeads = await fixtureLeads("global");
  assert.deepEqual(campaignLeadStats(campaignLeads), {
    companiesFound: 10,
    contactsFound: 11,
    emailsFound: 3,
    missingWebsites: 7,
  });
  assert.deepEqual(
    globalLeadStats(globalLeads, new Date("2026-08-05T00:00:00.000Z")),
    {
      totalLeads: 20,
      highQualityLeads: 11,
      newThisWeek: 20,
      topIndustry: "Automotive",
    },
  );
});
