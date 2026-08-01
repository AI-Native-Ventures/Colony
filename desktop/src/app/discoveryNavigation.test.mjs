import assert from "node:assert/strict";
import test from "node:test";

import { deriveShellRoute } from "./AppShell.helpers.ts";
import { buildDiscoverySearch } from "./navigation/useAppNavigation.ts";

test("discovery route derives the Discovery sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/discovery"), {
    selectedChannelId: null,
    selectedView: "discovery",
  });
});

test("discovery route ignores search when deriving shell selection", () => {
  assert.deepEqual(deriveShellRoute("/discovery?surface=campaign"), {
    selectedChannelId: null,
    selectedView: "discovery",
  });
});

test("discovery navigation preserves addressable search fields", () => {
  assert.deepEqual(
    buildDiscoverySearch({
      surface: "campaign",
      industryId: "automotive",
      verticalId: "auto-repair",
      campaignId: "auto-repair-johannesburg",
      tab: "discovery",
    }),
    {
      surface: "campaign",
      industryId: "automotive",
      verticalId: "auto-repair",
      campaignId: "auto-repair-johannesburg",
      tab: "discovery",
    },
  );
});
