// desktop/src/features/onboarding/flow/steps.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_STEPS,
  backStep,
  nextStep,
  resumeStep,
  stepPosition,
  visibleSteps,
} from "./steps.ts";

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

test("steps_are_nine_in_spec_order", () => {
  assert.equal(ONBOARDING_STEPS.length, 9);
  assert.equal(ONBOARDING_STEPS[0], "account");
  assert.equal(ONBOARDING_STEPS[7], "credits");
});

test("the_business_screen_no_longer_exists", () => {
  // Its two questions live on the company screen: one company, asked once.
  assert.ok(!ONBOARDING_STEPS.includes("business"));
});

test("company_leads_into_the_probe", () => {
  const answers = { ...base, hasWebsite: false };
  assert.equal(nextStep("company", answers), "probing");
});

test("no_website_skips_the_reading_step_after_the_brain_screen", () => {
  const answers = { ...base, hasWebsite: false };
  assert.equal(nextStep("brain", answers), "description");
});

test("a_website_goes_to_reading_after_the_brain_screen", () => {
  const answers = { ...base, hasWebsite: true, website: "example.com" };
  assert.equal(nextStep("brain", answers), "reading");
});

test("back_skips_steps_that_do_work_on_entry", () => {
  // Landing back on reading would re-run the scrape and spend money again,
  // and landing back on the probe would re-read the user's computer. The
  // company screen is the nearest screen before both that only asks.
  assert.equal(backStep("description"), "company");
  assert.equal(backStep("company"), "account");
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
    stage: "building",
    hasWebsite: false,
  };
  assert.equal(resumeStep(answers), "probing");
});

test("resume_returns_to_company_while_any_of_its_three_answers_is_missing", () => {
  const answered = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
    company: "Rosebank Auto Care",
    stage: "building",
    hasWebsite: false,
  };
  assert.equal(resumeStep({ ...answered, company: null }), "company");
  assert.equal(resumeStep({ ...answered, stage: null }), "company");
  assert.equal(resumeStep({ ...answered, hasWebsite: null }), "company");
});

test("no_website_drops_the_reading_screen_from_the_count", () => {
  const steps = visibleSteps({ hasWebsite: false, invitesEnabled: true });
  assert.ok(!steps.includes("reading"));
  assert.ok(steps.includes("description"));
});

test("an_unanswered_website_question_still_counts_the_reading_screen", () => {
  // It is coming unless someone says otherwise, so it is not dropped early.
  const steps = visibleSteps({ hasWebsite: null, invitesEnabled: true });
  assert.ok(steps.includes("reading"));
});

test("invites_shipping_dark_drop_the_invite_screen_from_the_count", () => {
  const steps = visibleSteps({ hasWebsite: true, invitesEnabled: false });
  assert.ok(!steps.includes("invite"));
  assert.equal(steps.at(-1), "credits");
});

test("the_brain_screen_is_always_counted", () => {
  for (const hasWebsite of [true, false, null]) {
    for (const invitesEnabled of [true, false]) {
      assert.ok(
        visibleSteps({ hasWebsite, invitesEnabled }).includes("brain"),
        `brain missing for hasWebsite=${hasWebsite} invites=${invitesEnabled}`,
      );
    }
  }
});

test("visible_steps_keep_the_spec_order_and_are_the_whole_list_when_nothing_is_dropped", () => {
  const steps = visibleSteps({ hasWebsite: true, invitesEnabled: true });
  assert.deepEqual(steps, [...ONBOARDING_STEPS]);
});

test("the_counter_never_jumps_by_more_than_one", () => {
  // The bug this replaced: the counter read 06 then 08 when the reading screen
  // was skipped, because it numbered screens the founder would never see.
  for (const hasWebsite of [true, false]) {
    for (const invitesEnabled of [true, false]) {
      const state = { hasWebsite, invitesEnabled };
      const answers = { ...base, hasWebsite };
      let current = "account";
      let previous = stepPosition(current, state);
      assert.equal(previous.index, 0);
      for (let guard = 0; guard < ONBOARDING_STEPS.length; guard += 1) {
        const next = nextStep(current, answers);
        if (next === "done") break;
        if (next === "invite" && !invitesEnabled) break;
        const position = stepPosition(next, state);
        assert.equal(
          position.index - previous.index,
          1,
          `${current} to ${next} moved the counter from ${previous.index} to ${position.index} (hasWebsite=${hasWebsite}, invites=${invitesEnabled})`,
        );
        assert.equal(position.total, previous.total);
        current = next;
        previous = position;
      }
      // The walk ends on the last screen the founder will see.
      assert.equal(
        previous.index,
        previous.total - 1,
        `the walk stopped at ${current}, not the last counted screen`,
      );
    }
  }
});

test("a_step_that_is_not_on_the_path_reports_the_first_position", () => {
  // Never renders "00": a resume mid-change degrades to screen one.
  assert.deepEqual(
    stepPosition("reading", { hasWebsite: false, invitesEnabled: false }),
    { index: 0, total: 7 },
  );
});
