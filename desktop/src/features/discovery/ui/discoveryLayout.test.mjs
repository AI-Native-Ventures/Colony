import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignTabForSearch,
  campaignDetailSearch,
  campaignProgressPercent,
  discoveryFilterKey,
  discoveryFiltersForSearch,
  discoverySurface,
  industryVerticalSearch,
  isCampaignListSearch,
  verticalCampaignsSearch,
} from "./discoveryLayout.ts";

test("direct campaign leads links infer the leads tab when tab is omitted", () => {
  assert.equal(
    campaignTabForSearch({
      surface: "leads",
      campaignId: "auto-repair-johannesburg",
    }),
    "leads",
  );
  assert.equal(
    campaignTabForSearch({
      surface: "campaign",
      campaignId: "auto-repair-johannesburg",
    }),
    "overview",
  );
});

test("industry selection enters the vertical surface with only industry context", () => {
  assert.deepEqual(industryVerticalSearch("automotive"), {
    surface: "verticals",
    industryId: "automotive",
  });
});

test("vertical selection enters its campaign list without selecting a campaign", () => {
  const search = verticalCampaignsSearch("automotive", "auto-repair");
  assert.deepEqual(search, {
    surface: "campaigns",
    industryId: "automotive",
    verticalId: "auto-repair",
  });
  assert.equal(isCampaignListSearch(search), true);
});

test("opening a campaign is an explicit follow-up navigation from the list", () => {
  assert.deepEqual(
    campaignDetailSearch(
      "automotive",
      "auto-repair",
      "auto-repair-johannesburg",
    ),
    {
      surface: "campaign",
      industryId: "automotive",
      verticalId: "auto-repair",
      campaignId: "auto-repair-johannesburg",
    },
  );
  assert.equal(
    isCampaignListSearch(
      campaignDetailSearch(
        "automotive",
        "auto-repair",
        "auto-repair-johannesburg",
      ),
    ),
    false,
  );
});

test("campaign progress is clamped and safe for empty targets", () => {
  assert.equal(campaignProgressPercent({ leadCount: 7, targetLeads: 10 }), 70);
  assert.equal(
    campaignProgressPercent({ leadCount: 15, targetLeads: 10 }),
    100,
  );
  assert.equal(campaignProgressPercent({ leadCount: -2, targetLeads: 0 }), 0);
});

test("surface-specific filters do not carry industry search into verticals", () => {
  const industrySearch = { surface: "industries" };
  const verticalSearch = {
    surface: "verticals",
    industryId: "automotive",
  };
  const filters = {
    [discoveryFilterKey(industrySearch)]: {
      query: "automotive",
      statusFilter: "all",
    },
  };

  assert.notEqual(
    discoveryFilterKey(industrySearch),
    discoveryFilterKey(verticalSearch),
  );
  assert.deepEqual(discoveryFiltersForSearch(filters, verticalSearch), {
    query: "",
    statusFilter: "all",
  });
});

test("a campaign leads tab resolves to the leads placeholder, not campaign list", () => {
  assert.equal(
    discoverySurface({
      surface: "campaign",
      campaignId: "auto-repair-johannesburg",
      tab: "leads",
    }),
    "leads",
  );
  assert.equal(
    discoverySurface({
      surface: "campaign",
      campaignId: "auto-repair-johannesburg",
      tab: "overview",
    }),
    "campaign",
  );
});
