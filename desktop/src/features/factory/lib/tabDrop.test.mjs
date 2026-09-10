import assert from "node:assert/strict";
import test from "node:test";

const seed = Math.random();

async function load() {
  return await import(`./tabDrop.ts?test=${seed}`);
}

async function loadTree() {
  return await import(`./tileTree.ts?test=${seed}`);
}

/** A two-pane tree: "main" holds t-1 and t-2, "side" holds t-3. */
async function twoPaneTree() {
  const tree = await loadTree();
  let state = tree.createInitialTree("main");
  state = tree.addTabToPane(state, "main", "t-1", { activate: true });
  state = tree.addTabToPane(state, "main", "t-2");
  const split = tree.insertPaneAtEdge(state, "main", "right", "side", "t-3");
  assert.ok(split);
  return {
    tree,
    state: {
      root: split.root,
      sizesByGroupId: split.sizesByGroupId,
      focusedPaneId: "main",
    },
  };
}

test("centre drop moves the tab into the target pane", async () => {
  const m = await load();
  const { tree, state } = await twoPaneTree();
  const next = m.dropTabOnPane(
    state,
    "t-2",
    { paneId: "side", zone: "center" },
    "unused",
  );
  assert.ok(next);
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "main")?.tabIds ?? [])],
    ["t-1"],
  );
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "side")?.tabIds ?? [])],
    ["t-3", "t-2"],
  );
  assert.strictEqual(next.focusedPaneId, "side");
});

test("centre drop on the tab's own pane is a no-op", async () => {
  const m = await load();
  const { state } = await twoPaneTree();
  assert.strictEqual(
    m.dropTabOnPane(state, "t-1", { paneId: "main", zone: "center" }, "new"),
    null,
  );
});

test("edge drop splits the target and focuses the new pane", async () => {
  const m = await load();
  const { tree, state } = await twoPaneTree();
  const next = m.dropTabOnPane(
    state,
    "t-2",
    { paneId: "side", zone: "bottom" },
    "new-pane",
  );
  assert.ok(next);
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "main")?.tabIds ?? [])],
    ["t-1"],
  );
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "new-pane")?.tabIds ?? [])],
    ["t-2"],
  );
  assert.strictEqual(next.focusedPaneId, "new-pane");
});

test("edge drop on the tab's own pane splits it out when it has siblings", async () => {
  const m = await load();
  const { tree, state } = await twoPaneTree();
  const next = m.dropTabOnPane(
    state,
    "t-2",
    { paneId: "main", zone: "right" },
    "new-pane",
  );
  assert.ok(next);
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "main")?.tabIds ?? [])],
    ["t-1"],
  );
  assert.deepStrictEqual(
    [...(tree.findPaneById(next.root, "new-pane")?.tabIds ?? [])],
    ["t-2"],
  );
});

test("edge drop of a pane's only tab onto itself is a no-op", async () => {
  const m = await load();
  const { state } = await twoPaneTree();
  assert.strictEqual(
    m.dropTabOnPane(state, "t-3", { paneId: "side", zone: "left" }, "new-pane"),
    null,
  );
});

test("a tab that is not in the tree is added rather than moved", async () => {
  const m = await load();
  const { tree, state } = await twoPaneTree();
  const centre = m.dropTabOnPane(
    state,
    "from-strip",
    { paneId: "side", zone: "center" },
    "unused",
  );
  assert.ok(centre);
  const sidePane = tree.findPaneById(centre.root, "side");
  assert.deepStrictEqual([...(sidePane?.tabIds ?? [])], ["t-3", "from-strip"]);
  assert.strictEqual(sidePane?.activeTabId, "from-strip");
  assert.deepStrictEqual(
    [...(tree.findPaneById(centre.root, "main")?.tabIds ?? [])],
    ["t-1", "t-2"],
  );

  const edge = m.dropTabOnPane(
    state,
    "from-strip",
    { paneId: "side", zone: "top" },
    "new-pane",
  );
  assert.ok(edge);
  assert.deepStrictEqual(
    [...(tree.findPaneById(edge.root, "new-pane")?.tabIds ?? [])],
    ["from-strip"],
  );
  assert.deepStrictEqual(
    [...(tree.findPaneById(edge.root, "side")?.tabIds ?? [])],
    ["t-3"],
  );
});

test("dropping on an unknown pane returns null", async () => {
  const m = await load();
  const { state } = await twoPaneTree();
  assert.strictEqual(
    m.dropTabOnPane(state, "t-1", { paneId: "ghost", zone: "center" }, "new"),
    null,
  );
  assert.strictEqual(
    m.dropTabOnPane(state, "t-1", { paneId: "ghost", zone: "right" }, "new"),
    null,
  );
});

test("a drop leaves the source state untouched", async () => {
  const m = await load();
  const { state } = await twoPaneTree();
  const before = JSON.stringify(state);
  m.dropTabOnPane(state, "t-2", { paneId: "side", zone: "center" }, "new");
  m.dropTabOnPane(state, "t-2", { paneId: "side", zone: "left" }, "new");
  assert.strictEqual(JSON.stringify(state), before);
});
