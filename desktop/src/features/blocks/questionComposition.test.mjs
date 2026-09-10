import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateBlockManifest } from "./blockValidation.ts";

const fixture = JSON.parse(
  await readFile(
    new URL(
      "../../../../crates/buzz-relay/src/core_blocks/primitives/question.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function manifest(tree, actions = fixture.actions) {
  return { ...fixture, tree, actions, examples: [] };
}

test("Question descendants of repeated cards are refused before they can publish unusable answers", () => {
  for (const card of [
    fixture.tree,
    { type: "card", children: [fixture.tree] },
    { type: "stack", gap: "medium", children: [fixture.tree] },
  ]) {
    const result = validateBlockManifest(
      manifest({ type: "card-list", items_path: "/items", card }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /Question cannot appear inside a card-list/);
  }
});

test("one submit action cannot ambiguously address separate Question nodes", () => {
  const result = validateBlockManifest(
    manifest({
      type: "stack",
      gap: "medium",
      children: [fixture.tree, { type: "card", children: [fixture.tree] }],
    }),
  );
  assert.equal(result.ok, false);
  assert.match(
    result.message,
    /Each Question must have a unique submit_action/,
  );
});

test("separate Question nodes remain supported when each has its own signed action", () => {
  const action = structuredClone(fixture.actions[0]);
  action.id = "second.submit";
  action.interaction.action_id = action.id;
  const result = validateBlockManifest(
    manifest(
      {
        type: "stack",
        gap: "medium",
        children: [fixture.tree, { ...fixture.tree, submit_action: action.id }],
      },
      [...fixture.actions, action],
    ),
  );
  assert.equal(result.ok, true, result.message);
});
