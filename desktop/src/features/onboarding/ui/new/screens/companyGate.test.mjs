import assert from "node:assert/strict";
import test from "node:test";

import { companyBlockedReason, companyReady } from "./CompanyScreen.tsx";

const answered = {
  company: "Rosebank Auto Care",
  stage: "building",
  hasWebsite: false,
  website: "",
};

test("company_gate_wants_all_three_answers", () => {
  assert.equal(companyReady(answered), true);
  assert.equal(companyReady({ ...answered, company: "  " }), false);
  assert.equal(companyReady({ ...answered, stage: null }), false);
  assert.equal(companyReady({ ...answered, hasWebsite: null }), false);
});

test("company_gate_wants_a_real_address_when_there_is_a_website", () => {
  const withSite = { ...answered, hasWebsite: true };
  assert.equal(companyReady({ ...withSite, website: "" }), false);
  assert.equal(companyReady({ ...withSite, website: "asdf" }), false);
  assert.equal(
    companyReady({ ...withSite, website: "rosebankautocare.co.za" }),
    true,
  );
});

test("company_gate_ignores_a_stale_address_once_the_answer_is_no", () => {
  // Someone who types an address and then answers "No" is not blocked by
  // what they typed before changing their mind.
  assert.equal(
    companyReady({ ...answered, hasWebsite: false, website: "asdf" }),
    true,
  );
});

test("a_disabled_action_always_names_what_is_missing", () => {
  assert.equal(companyBlockedReason(answered), null);
  assert.equal(
    companyBlockedReason({ ...answered, company: "" }),
    "Enter your company name to continue.",
  );
  assert.equal(
    companyBlockedReason({ ...answered, stage: null }),
    "Answer both questions to continue.",
  );
  assert.equal(
    companyBlockedReason({ ...answered, hasWebsite: true, website: "asdf" }),
    "Check the web address above to continue.",
  );
});
