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

test("two forms keep recovery inside account setup", () => {
  const visibility = { invitesEnabled: false, creditsNeeded: true };
  assert.deepEqual(visibleSteps(visibility), ["account", "company"]);
  assert.deepEqual(stepPosition("recovery", visibility), {
    index: 0,
    total: 2,
  });
  assert.deepEqual(stepPosition("company", visibility), { index: 1, total: 2 });
  assert.equal(nextStep("account", EMPTY_ANSWERS), "recovery");
  assert.equal(nextStep("recovery", EMPTY_ANSWERS), "company");
  assert.equal(nextStep("company", EMPTY_ANSWERS), "done");
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
