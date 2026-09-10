import assert from "node:assert/strict";
import test from "node:test";
import {
  readBlockField,
  resolveDetailsItems,
  resolveQuestionMode,
  validateBlockFieldBindings,
  validateDynamicBlockFields,
} from "./dynamicBlockFields.ts";
import { resolveInterviewActionInputs } from "./interviewAction.ts";

const question = {
  type: "question",
  mode: "multi-select",
  mode_path: "/mode",
  min_selections: 1,
  max_selections: 12,
};
test("data-backed single choice bounds answers to one while old fixed definitions are unchanged", () => {
  assert.equal(
    resolveQuestionMode(question, { mode: "single-select" }).node
      .max_selections,
    1,
  );
  assert.equal(
    resolveQuestionMode(question, { mode: "multi-select" }).node.max_selections,
    12,
  );
  assert.equal(resolveQuestionMode(question, { mode: "arbitrary" }).ok, false);
  assert.equal(resolveQuestionMode(question, { mode: null }).ok, false);
  const legacy = { ...question, mode_path: undefined };
  assert.equal(
    resolveQuestionMode(legacy, { mode: "single-select" }).node,
    legacy,
  );
});
test("details preserve populated literal values and legacy item templates", () => {
  const node = {
    type: "details",
    items_path: "/items",
    items: [{ label: "{{label}}", value: "{{value}}" }],
  };
  const items = [
    { label: "Brief", value: "Keep {{this}} literal", format: "text" },
  ];
  assert.deepEqual(resolveDetailsItems(node, { items }), {
    ok: true,
    items,
    dynamic: true,
  });
  assert.deepEqual(resolveDetailsItems(node, { label: "Owner", value: "Mo" }), {
    ok: true,
    items: node.items,
    dynamic: false,
  });
  for (const bad of [
    [],
    Array(25).fill(items[0]),
    [{ label: "", value: "x" }],
    [{ label: "A", value: "x", html: true }],
  ])
    assert.equal(resolveDetailsItems(node, { items: bad }).ok, false);
});
test("field bindings are bounded, paired and do not read inherited properties", () => {
  assert.match(
    validateBlockFieldBindings({ type: "status", position_path: "/position" }),
    /together/,
  );
  assert.equal(
    validateBlockFieldBindings({
      type: "status",
      position_path: "/position",
      total_path: "/total",
    }),
    null,
  );
  assert.equal(
    readBlockField(Object.create({ mode: "single-select" }), "/mode"),
    undefined,
  );
  assert.match(
    validateDynamicBlockFields(
      { type: "details", items: [], items_path: "not-a-pointer" },
      {},
    ),
    /Pointer/,
  );
});
test("Interview unknown action carries its exact fact and never enables generic answer or other handles", () => {
  assert.deepEqual(
    [...resolveInterviewActionInputs("interview", { fact: "pricing" })],
    [["interview.unknown", { fact: "pricing" }]],
  );
  for (const fact of [undefined, "", " ", "x".repeat(81), 1])
    assert.equal(resolveInterviewActionInputs("interview", { fact }).size, 0);
  assert.equal(
    resolveInterviewActionInputs("approval", { fact: "pricing" }).size,
    0,
  );
});
