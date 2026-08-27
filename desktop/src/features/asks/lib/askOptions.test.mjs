import assert from "node:assert/strict";
import test from "node:test";

import { buildAskAnswer, readAskOptions } from "./askOptions.ts";

const CONTENT = JSON.stringify({
  headline: "Choose batch size",
  cost_of_delay: "47 leads wait",
  options: [
    { label: "A", consequence: "sends 47 emails" },
    { label: "B", consequence: "sends 15 emails", recommended: true },
    { label: "C", consequence: "sends nothing" },
  ],
  default_option: "C",
});

test("reads label, consequence, recommended, and default separately", () => {
  const { options, defaultOption } = readAskOptions(CONTENT);
  assert.equal(defaultOption, "C");
  assert.deepEqual(options, [
    {
      label: "A",
      consequence: "sends 47 emails",
      recommended: false,
      isDefault: false,
    },
    {
      label: "B",
      consequence: "sends 15 emails",
      recommended: true,
      isDefault: false,
    },
    {
      label: "C",
      consequence: "sends nothing",
      recommended: false,
      isDefault: true,
    },
  ]);
});

test("recommended and default may be different options", () => {
  const { options } = readAskOptions(CONTENT);
  const recommended = options.find((option) => option.recommended);
  const fallback = options.find((option) => option.isDefault);
  assert.equal(recommended?.label, "B");
  assert.equal(fallback?.label, "C");
});

test("an ask with a recommendation and no default has no default flagged", () => {
  const { options, defaultOption } = readAskOptions(
    JSON.stringify({
      options: [{ label: "Approve", recommended: true }],
    }),
  );
  assert.equal(defaultOption, null);
  assert.equal(options[0].isDefault, false);
  assert.equal(options[0].consequence, null);
});

test("an optionless ask reads as no options at all", () => {
  assert.deepEqual(readAskOptions(JSON.stringify({ headline: "Hi" })), {
    options: [],
    defaultOption: null,
  });
});

test("malformed content never throws and never fabricates options", () => {
  assert.deepEqual(readAskOptions("{"), { options: [], defaultOption: null });
  assert.deepEqual(readAskOptions("[]"), { options: [], defaultOption: null });
  assert.deepEqual(readAskOptions(JSON.stringify({ options: "A or B" })), {
    options: [],
    defaultOption: null,
  });
});

test("one malformed entry drops without taking the rest with it", () => {
  const { options } = readAskOptions(
    JSON.stringify({
      options: [{ label: "" }, null, "A", { label: "Real", consequence: "x" }],
    }),
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ["Real"],
  );
});

test("a duplicate label keeps the first, so the answer stays unambiguous", () => {
  const { options } = readAskOptions(
    JSON.stringify({
      options: [
        { label: "A", consequence: "first" },
        { label: "A", consequence: "second" },
      ],
    }),
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].consequence, "first");
});

test("a default naming no visible option is not reported as a default", () => {
  const { options, defaultOption } = readAskOptions(
    JSON.stringify({ options: [{ label: "A" }], default_option: "Z" }),
  );
  assert.equal(defaultOption, null);
  assert.equal(options[0].isDefault, false);
});

// --- resolution payload -----------------------------------------------------

test("an option answer publishes `option`, the relay's own key for a chosen option", () => {
  assert.deepEqual(
    buildAskAnswer({ optionLabel: "B", decision: "", rationale: "cheaper" }),
    { option: "B", decision: "B", rationale: "cheaper" },
  );
});

test("free text alongside an option is kept as the decision", () => {
  assert.deepEqual(
    buildAskAnswer({
      optionLabel: "B",
      decision: "B, but only this week",
      rationale: "",
    }),
    { option: "B", decision: "B, but only this week", rationale: "" },
  );
});

test("an optionless answer is unchanged from the pre-options payload", () => {
  assert.deepEqual(
    buildAskAnswer({ optionLabel: null, decision: "approve", rationale: "ok" }),
    { decision: "approve", rationale: "ok" },
  );
});

test("whitespace-only selections and answers are trimmed away", () => {
  assert.deepEqual(
    buildAskAnswer({
      optionLabel: "  ",
      decision: "  approve  ",
      rationale: " ",
    }),
    { decision: "approve", rationale: "" },
  );
});

test("the payload never claims a default fired", () => {
  const answer = buildAskAnswer({
    optionLabel: "B",
    decision: "",
    rationale: "",
  });
  assert.equal("default_executed" in answer, false);
});
