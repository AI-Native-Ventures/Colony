import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditableCompanySummary,
  COMPANY_SCAN_TIMEOUT_MS,
  fromRawCompanyScan,
} from "./tauriCompanyScan.ts";

test("company scan adapter normalizes Rust and test-fixture field shapes", () => {
  const result = fromRawCompanyScan({
    requested_url: "https://example.com",
    canonical_url: "https://example.com/",
    pages: [
      {
        url: "https://example.com/",
        title: { value: "Example" },
        description: { value: "We help growing teams." },
        text: "Useful evidence",
      },
    ],
    warnings: [],
  });
  assert.equal(result.canonicalUrl, "https://example.com/");
  assert.match(buildEditableCompanySummary(result), /growing teams/);
});

test("editable scan summaries are bounded and the timeout is five minutes", () => {
  const summary = buildEditableCompanySummary({
    requestedUrl: "https://example.com",
    canonicalUrl: "https://example.com/",
    pages: [{ url: "https://example.com", text: "x".repeat(2_000) }],
    warnings: [],
  });
  assert.ok(summary.length <= 1_200);
  assert.equal(COMPANY_SCAN_TIMEOUT_MS, 300_000);
});
