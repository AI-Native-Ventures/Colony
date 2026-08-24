import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvedCampaignBudgetNanousd,
  campaignBudgetFingerprint,
} from "./campaignBudget.ts";

test("Campaign budget fingerprint matches the Rust contract vector", async () => {
  const fingerprint = await campaignBudgetFingerprint({
    campaignId: "00000000-0000-0000-0000-000000000003",
    industryId: "healthcare",
    verticalId: "dentists",
    query: "dentists",
    location: "Sandton, South Africa",
    target: 100,
    language: "en",
    region: "ZA",
    payerPubkey: "11".repeat(32),
  });

  assert.equal(
    fingerprint,
    "9c9192ad1893bf8122ff29ef3f0ca90e5c227639c685b1f4844ad8884d3596c7",
  );
  assert.equal(approvedCampaignBudgetNanousd(100), "5000000000");
});
