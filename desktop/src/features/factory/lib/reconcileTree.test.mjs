import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./reconcileTree.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

function makePane(id, tabIds) {
  return {
    kind: "pane",
    id,
    tabIds: [...tabIds],
    activeTabId: tabIds[0] ?? null,
  };
}

function makeGroup(id, dir, children) {
  return { kind: "group", id, direction: dir, children: [...children] };
}

test("reconcileTree drops missing tabs", async () => {
  const m = await load();
  const { createInitialTree } = await import("./tileTree.ts?test=" + Math.random());
  const state = createInitialTree("main");
  const withTab = (await import("./tileTree.ts?test=" + Math.random())).addTabToPane(state, "main", "t-1");
  const reconciled = m.reconcileTree(withTab, ["t-1", "t-2"], "factory");
  assert.deepEqual(reconciled.root.tabIds, ["t-1", "t-2"]);
});

test("reconcileTree excludes factory tab id", async () => {
  const m = await load();
  const { createInitialTree, addTabToPane } = await import("./tileTree.ts?test=" + Math.random());
  let state = createInitialTree("main");
  state = addTabToPane(state, "main", "factory-tab");
  const reconciled = m.reconcileTree(state, ["factory-tab", "t-1"], "factory-tab");
  assert.strictEqual(reconciled.root.tabIds.length, 1);
  assert.strictEqual(reconciled.root.tabIds[0], "t-1");
});

test("reconcileTree keeps empty root pane when emptied", async () => {
  const m = await load();
  const { createInitialTree, addTabToPane, removeTab } = await import("./tileTree.ts?test=" + Math.random());
  let state = createInitialTree("main");
  state = addTabToPane(state, "main", "t-1");
  const reconciled = m.reconcileTree(state, [], "factory");
  assert.strictEqual(reconciled.root.kind, "pane");
  assert.deepEqual(reconciled.root.tabIds, []);
});

test("reconcileTree drops missing nested tabs and promotes single child", async () => {
  const m = await load();
  const paneA = makePane("a", ["t-a", "t-b"]);
  const paneB = makePane("b", ["t-c"]);
  const root = makeGroup("grp", "horizontal", [paneA, paneB]);
  const state = { root, sizesByGroupId: {}, focusedPaneId: "a" };
  const reconciled = m.reconcileTree(state, ["t-c"], "factory");
  // After removing missing tabs, pane A is removed (only t-c remains in pane B)
  assert.equal(reconciled.root.kind, "pane");
  assert.equal(reconciled.root.id, "b");
});
