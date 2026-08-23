// desktop/src/features/onboarding/flow/steps.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { ONBOARDING_STEPS, backStep, nextStep, resumeStep } from "./steps.ts";

const base = {
  account: null,
  recoveryAcknowledged: false,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
};

test("steps_are_ten_in_spec_order", () => {
  assert.equal(ONBOARDING_STEPS.length, 10);
  assert.equal(ONBOARDING_STEPS[0], "account");
  assert.equal(ONBOARDING_STEPS[8], "credits");
});

test("business_with_no_website_skips_the_reading_step", () => {
  const answers = { ...base, hasWebsite: false };
  assert.equal(nextStep("business", answers), "description");
});

test("business_with_a_website_goes_to_reading", () => {
  const answers = { ...base, hasWebsite: true, website: "example.com" };
  assert.equal(nextStep("business", answers), "reading");
});

test("back_skips_steps_that_do_work_on_entry", () => {
  // Landing back on reading would re-run the scrape and spend money again.
  assert.equal(backStep("description"), "business");
  // Landing back on the probe would re-probe, and on install would reinstall.
  assert.equal(backStep("business"), "company");
});

test("back_is_absent_where_it_has_no_meaning", () => {
  assert.equal(backStep("account"), null);
  assert.equal(backStep("recovery"), null);
  assert.equal(backStep("probing"), null);
});

test("resume_lands_on_the_first_unanswered_step", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
  };
  assert.equal(resumeStep(answers), "company");
});

test("resume_reruns_probing_rather_than_restoring_a_partial_result", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
    company: "Rosebank Auto Care",
  };
  assert.equal(resumeStep(answers), "probing");
});
