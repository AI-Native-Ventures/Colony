import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_ANSWERS } from "./persistence.ts";
import {
  nextStep,
  resumeStep,
  stepPosition,
  visibleSteps,
  creditsNeeded,
  backStep,
} from "./steps.ts";

test("four steps keep recovery inside account setup", () => {
  const visibility = { invitesEnabled: false, creditsNeeded: true };
  assert.deepEqual(visibleSteps(visibility), [
    "account",
    "company",
    "brain",
    "history",
  ]);
  assert.deepEqual(stepPosition("recovery", visibility), {
    index: 0,
    total: 4,
  });
  assert.deepEqual(stepPosition("company", visibility), { index: 1, total: 4 });
  assert.equal(nextStep("account", EMPTY_ANSWERS), "recovery");
  assert.equal(nextStep("recovery", EMPTY_ANSWERS), "company");
  assert.equal(nextStep("company", EMPTY_ANSWERS), "brain");
});
test("resume never skips account recovery or resurrects removed setup questions", () => {
  assert.equal(resumeStep(EMPTY_ANSWERS), "account");
  const account = { ...EMPTY_ANSWERS, account: { email: "owner@example.com" } };
  assert.equal(resumeStep(account), "recovery");
  const acknowledged = { ...account, recoveryAcknowledged: true };
  for (const legacy of [
    {},
    { company: "Horizon", stage: null, hasWebsite: null },
    {
      company: "Horizon",
      track: "colony",
      brain: "colony-hosted",
      paid: false,
    },
  ]) {
    assert.equal(resumeStep({ ...acknowledged, ...legacy }), "company");
    assert.equal(creditsNeeded({ ...acknowledged, ...legacy }), false);
  }
  assert.equal(
    backStep("company", { invitesEnabled: false, creditsNeeded: false }),
    null,
  );
});

test("power resumes only after explicit business confirmation", () => {
  const confirmed = {
    ...EMPTY_ANSWERS,
    account: { email: "owner@example.test" },
    recoveryAcknowledged: true,
    businessConfirmed: true,
  };
  assert.equal(resumeStep(confirmed), "brain");
  assert.equal(
    resumeStep({ ...confirmed, recoveryAcknowledged: false }),
    "recovery",
  );
  assert.equal(resumeStep({ ...confirmed, account: null }), "account");
  assert.equal(nextStep("brain", confirmed), "history");
});
