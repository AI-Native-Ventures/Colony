import assert from "node:assert/strict";
import test from "node:test";

import { buildFreeTextAnswer, buildOptionAnswer } from "./askComposerAnswer.ts";

test("an option tap with an empty rationale still produces a valid answer", () => {
  const answer = buildOptionAnswer("Ship it", "");
  assert.deepEqual(answer, {
    decision: "Go with: Ship it",
    rationale: "",
    optionLabel: "Ship it",
  });
});

test("an option tap carries any typed rationale, trimmed", () => {
  const answer = buildOptionAnswer("Ship it", "  it's ready  ");
  assert.deepEqual(answer, {
    decision: "Go with: Ship it",
    rationale: "it's ready",
    optionLabel: "Ship it",
  });
});

test("a free-text submit with an empty decision is refused", () => {
  assert.equal(buildFreeTextAnswer("", ""), null);
});

test("a free-text submit with only whitespace is refused, same as empty", () => {
  assert.equal(buildFreeTextAnswer("   ", "some rationale"), null);
});

test("a free-text submit with a decision produces a valid answer, optionLabel null", () => {
  const answer = buildFreeTextAnswer(
    "  Approve the budget  ",
    "  onboarding is blocked  ",
  );
  assert.deepEqual(answer, {
    decision: "Approve the budget",
    rationale: "onboarding is blocked",
    optionLabel: null,
  });
});

test("a free-text submit with an empty rationale is still valid: rationale is optional", () => {
  const answer = buildFreeTextAnswer("Approve", "");
  assert.deepEqual(answer, {
    decision: "Approve",
    rationale: "",
    optionLabel: null,
  });
});
