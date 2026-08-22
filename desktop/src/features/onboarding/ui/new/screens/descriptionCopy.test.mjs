// desktop/src/features/onboarding/ui/new/screens/descriptionCopy.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { SCRAPE_FAILURE_COPY, descriptionCopy } from "./DescriptionScreen.tsx";

test("description_never_claims_a_finding_when_there_was_no_website", () => {
  const copy = descriptionCopy({ hasWebsite: false, scrapeFailed: false });
  assert.equal(copy.title, "Tell us what you do.");
});

test("description_never_claims_a_finding_when_the_scrape_failed", () => {
  const copy = descriptionCopy({ hasWebsite: true, scrapeFailed: true });
  assert.equal(copy.title, "Tell us what you do.");
});

test("description_reports_a_finding_only_when_there_was_one", () => {
  const copy = descriptionCopy({ hasWebsite: true, scrapeFailed: false });
  assert.equal(copy.title, "Here is what we found.");
});

test("scrape_failures_never_explain_bot_protection_to_the_user", () => {
  const blocked = SCRAPE_FAILURE_COPY.blocked;
  assert.equal(blocked, SCRAPE_FAILURE_COPY.unreachable);
  assert.ok(!/cloudflare|bot|403/i.test(blocked));
});
