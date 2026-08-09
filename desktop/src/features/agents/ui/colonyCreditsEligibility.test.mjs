import assert from "node:assert/strict";
import test from "node:test";

import { isColonyCreditsEligible } from "./colonyCreditsEligibility.ts";

test("Colony Credits eligibility matches the supported runtime/provider matrix", () => {
  assert.equal(isColonyCreditsEligible("codex", "anthropic"), true);
  assert.equal(isColonyCreditsEligible("goose", "openai"), true);
  assert.equal(isColonyCreditsEligible("buzz-agent", "OPENAI-COMPAT"), true);
  assert.equal(isColonyCreditsEligible("goose", "anthropic"), false);
  assert.equal(isColonyCreditsEligible("buzz-agent", undefined), false);
  assert.equal(isColonyCreditsEligible("claude", "openai"), false);
});
