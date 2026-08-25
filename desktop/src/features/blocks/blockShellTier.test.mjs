import assert from "node:assert/strict";
import test from "node:test";

import { blockShellTier, WIDGET_BLOCK_TYPES } from "./blockShellTier.ts";

// Minimal well-formed node builders so tests describe structure, not field
// noise. Every shape here matches a member of the BlockNode union in
// contracts.ts.

function stack(children) {
  return { type: "stack", gap: "small", children };
}
function grid(children, columns = 2) {
  return { type: "grid", columns, gap: "small", children };
}
function card(children) {
  return { type: "card", title: "Card", children };
}
function cardList(card) {
  return { type: "card-list", items_path: "items", card };
}
function section(title = "Title") {
  return { type: "section", title, text: "Body" };
}
function metric() {
  return { type: "metric", label: "Label", value: "1" };
}
function details() {
  return { type: "details", items: [{ label: "K", value: "V" }] };
}
function status() {
  return { type: "status", label: "Status" };
}
function table() {
  return {
    type: "table",
    columns: [{ key: "k", label: "K" }],
    rows_path: "rows",
  };
}
function chart() {
  return {
    type: "chart",
    kind: "bar",
    data_path: "data",
    label_key: "l",
    value_key: "v",
  };
}
function media() {
  return { type: "media", url: "https://example.com/a.png", alt: "a" };
}
function actions() {
  return {
    type: "actions",
    controls: [
      {
        label: "Approve",
        interaction: {
          type: "signed",
          action_id: "a",
          resolves_attention: true,
        },
      },
    ],
  };
}
function question() {
  return {
    type: "question",
    prompt: "Pick one",
    mode: "single-select",
    options: [{ id: "a", label: "A" }],
    min_selections: 1,
    max_selections: 1,
    allow_custom: false,
    require_custom_input: false,
    submit_action: "submit",
  };
}

test("a stack of only passive primitives renders inline", () => {
  const tree = stack([section(), metric(), details(), status()]);
  assert.equal(blockShellTier(tree), "inline");
});

test("a stack containing a table renders framed", () => {
  const tree = stack([section(), table()]);
  assert.equal(blockShellTier(tree), "framed");
});

test("a widget nested two levels deep (grid > card > chart) renders framed", () => {
  const tree = grid([card([chart()])]);
  assert.equal(blockShellTier(tree), "framed");
});

test("a card-list whose card holds only a section still renders framed", () => {
  const tree = cardList([section()]);
  assert.equal(blockShellTier(tree), "framed");
});

test("each widget primitive alone makes the block framed", () => {
  for (const leaf of [table(), chart(), question(), actions(), media()]) {
    assert.equal(
      blockShellTier(stack([leaf])),
      "framed",
      `${leaf.type} should frame`,
    );
  }
  assert.equal(blockShellTier(cardList([section()])), "framed");
});

test("a bare question or actions forces a frame even at the root", () => {
  assert.equal(blockShellTier(question()), "framed");
  assert.equal(blockShellTier(actions()), "framed");
});

test("nested layout nodes with only passive children stay inline", () => {
  const tree = stack([
    stack([section(), metric()]),
    grid([section(), details(), status()]),
  ]);
  assert.equal(blockShellTier(tree), "inline");
});

test("a widget inside a nested layout (card > stack > chart) renders framed", () => {
  const tree = card([stack([grid([chart()])])]);
  assert.equal(blockShellTier(tree), "framed");
});

test("WIDGET_BLOCK_TYPES contains exactly the frame-forcing primitives", () => {
  assert.deepEqual([...WIDGET_BLOCK_TYPES].sort(), [
    "actions",
    "card",
    "card-list",
    "chart",
    "media",
    "question",
    "table",
  ]);
});

test("malformed or unknown input fails safe to framed", () => {
  assert.equal(blockShellTier(null), "framed");
  assert.equal(blockShellTier(undefined), "framed");
  assert.equal(blockShellTier("section"), "framed");
  assert.equal(blockShellTier(42), "framed");
  assert.equal(blockShellTier({}), "framed");
  assert.equal(blockShellTier({ type: "not-a-real-primitive" }), "framed");
  assert.equal(blockShellTier([section()]), "framed");
  assert.equal(blockShellTier({ children: [section()] }), "framed");
});

test("a self-referential layout tree does not hang and fails safe", () => {
  // Two layout-only nodes referencing each other contain no widget primitive,
  // so termination (not classification) is what is being tested here.
  const nodeA = { type: "stack", gap: "small", children: [] };
  const nodeB = { type: "stack", gap: "small", children: [] };
  nodeA.children.push(nodeB);
  nodeB.children.push(nodeA); // cycle
  assert.equal(blockShellTier(nodeA), "framed");
});
