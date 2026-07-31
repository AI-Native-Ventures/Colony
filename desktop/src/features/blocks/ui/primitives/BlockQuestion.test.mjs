import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveQuestionOptions,
  resolveQuestionSubmission,
} from "./BlockQuestion.tsx";

const base = {
  type: "question",
  prompt: "What should we pursue?",
  mode: "multi-select",
  options: [
    { id: "quality", label: "Premium quality" },
    { id: "motion", label: "Cinematic motion" },
  ],
  min_selections: 1,
  max_selections: 2,
  allow_custom: true,
  require_custom_input: false,
  submit_action: "question.submit",
};

test("block question enforces min/max and includes optional custom input", () => {
  assert.equal(
    resolveQuestionSubmission({
      node: base,
      selected: new Set(),
      customInput: "",
    }).ok,
    false,
  );
  assert.deepEqual(
    resolveQuestionSubmission({
      node: base,
      selected: new Set(["motion", "quality"]),
      customInput: "Use a darker palette",
    }),
    {
      ok: true,
      input: {
        selected: ["motion", "quality"],
        custom_input: "Use a darker palette",
      },
    },
  );
});

test("block question can require an explanation", () => {
  const result = resolveQuestionSubmission({
    node: { ...base, require_custom_input: true },
    selected: new Set(["quality"]),
    customInput: " ",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /explanation/);
});

test("block question resolves strict described data-backed options", () => {
  assert.deepEqual(
    resolveQuestionOptions(
      { ...base, options: undefined, options_path: "/choices" },
      {
        choices: [
          {
            id: "premium",
            label: "Premium editorial",
            description: "Restrained typography and strong art direction.",
          },
          {
            id: "motion",
            label: "Cinematic motion",
            description: "Purposeful transitions and pacing.",
          },
        ],
      },
    ),
    {
      ok: true,
      options: [
        {
          id: "premium",
          label: "Premium editorial",
          description: "Restrained typography and strong art direction.",
        },
        {
          id: "motion",
          label: "Cinematic motion",
          description: "Purposeful transitions and pacing.",
        },
      ],
    },
  );
});

test("block question fails closed on malformed, duplicate, or oversized data options", () => {
  const node = { ...base, options: undefined, options_path: "/choices" };
  for (const choices of [
    [{ id: "premium", label: "Missing description" }],
    [
      { id: "same", label: "One", description: "First" },
      { id: "same", label: "Two", description: "Second" },
    ],
    Array.from({ length: 13 }, (_, index) => ({
      id: `option-${index + 1}`,
      label: `Option ${index + 1}`,
      description: "Too many options",
    })),
  ]) {
    assert.equal(resolveQuestionOptions(node, { choices }).ok, false);
  }
});
