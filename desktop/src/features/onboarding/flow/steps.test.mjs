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

test("steps_are_seven_in_spec_order", () => {
  assert.equal(ONBOARDING_STEPS.length, 7);
  assert.deepEqual(
    [...ONBOARDING_STEPS],
    [
      "account",
      "recovery",
      "company",
      "building",
      "brain",
      "credits",
      "invite",
    ],
  );
});

test("the_screens_that_merged_no_longer_exist", () => {
  // business folded into company; probing, reading and description folded
  // into building.
  for (const gone of ["business", "probing", "reading", "description"]) {
    assert.ok(!ONBOARDING_STEPS.includes(gone), `${gone} is still a step`);
  }
});

test("company_leads_into_building", () => {
  assert.equal(nextStep("company", base), "building");
});

test("the_website_answer_no_longer_moves_anyone_between_screens", () => {
  // Reading is a line inside building now, so building asks the question of
  // itself rather than the flow routing around a screen.
  for (const hasWebsite of [true, false, null]) {
    assert.equal(nextStep("building", { ...base, hasWebsite }), "brain");
  }
});

test("back_never_lands_on_a_step_that_does_work_on_entry", () => {
  // Landing back on building would re-read the user's computer and spend
  // money on a second scrape.
  for (const step of ONBOARDING_STEPS) {
    assert.notEqual(backStep(step), "building", `${step} goes back to work`);
  }
  assert.equal(backStep("company"), "account");
});

test("back_is_absent_where_it_has_no_meaning", () => {
  assert.equal(backStep("account"), null);
  assert.equal(backStep("recovery"), null);
  assert.equal(backStep("building"), null);
});

test("resume_lands_on_the_first_unanswered_step", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
  };
  assert.equal(resumeStep(answers), "company");
});

test("resume_reruns_building_rather_than_restoring_a_partial_result", () => {
  const answers = {
    ...base,
    account: { email: "a@b.com" },
    recoveryAcknowledged: true,
    company: "Rosebank Auto Care",
    stage: "building",
    hasWebsite: false,
  };
  // Neither half of building's work is answered yet.
  assert.equal(resumeStep(answers), "building");
  // Nor is it when only one half is.
  assert.equal(resumeStep({ ...answers, track: "colony" }), "building");
  assert.equal(
    resumeStep({ ...answers, description: "We fix cars." }),
    "building",
  );
  assert.equal(
    resumeStep({ ...answers, track: "colony", description: "We fix cars." }),
    "brain",
  );
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

test("invites_shipping_dark_leave_the_six_screens_a_founder_sees", () => {
  const steps = visibleSteps({ invitesEnabled: false });
  assert.ok(!steps.includes("invite"));
  assert.equal(steps.length, 6);
  assert.equal(steps.at(-1), "credits");
});

test("the_brain_screen_is_always_counted", () => {
  for (const invitesEnabled of [true, false]) {
    assert.ok(
      visibleSteps({ invitesEnabled }).includes("brain"),
      `brain missing for invites=${invitesEnabled}`,
    );
  }
});

test("visible_steps_keep_the_spec_order_and_are_the_whole_list_when_nothing_is_dropped", () => {
  const steps = visibleSteps({ invitesEnabled: true });
  assert.deepEqual(steps, [...ONBOARDING_STEPS]);
});

test("the_counter_never_jumps_by_more_than_one", () => {
  // The bug this replaced: the counter read 06 then 08 when a screen was
  // skipped, because it numbered screens the founder would never see.
  for (const hasWebsite of [true, false]) {
    for (const invitesEnabled of [true, false]) {
      const state = { invitesEnabled };
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
  assert.deepEqual(stepPosition("invite", { invitesEnabled: false }), {
    index: 0,
    total: 6,
  });
});
