import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./tileTree.ts?test=${Math.random()}`;

async function load() {
  const module = await import(importPath);
  return module;
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

test("createInitialTree builds a single empty root pane", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  assert.equal(state.root.kind, "pane");
  assert.equal(state.root.id, "main");
  assert.deepEqual(state.root.tabIds, []);
  assert.equal(state.root.activeTabId, null);
  assert.equal(state.focusedPaneId, "main");
  assert.deepEqual(state.sizesByGroupId, {});
});

test("findPaneById locates root and nested panes", async () => {
  const m = await load();
  const paneA = makePane("a", ["t-a"]);
  const paneB = makePane("b", ["t-b"]);
  const root = makeGroup("g", "horizontal", [paneA, paneB]);
  assert.strictEqual(m.findPaneById(root, "a"), paneA);
  assert.strictEqual(m.findPaneById(root, "b"), paneB);
  assert.strictEqual(m.findPaneById(root, "missing"), null);
  assert.strictEqual(m.findPaneById(null, "a"), null);
});

test("findPaneByTabId finds the pane holding a tab id", async () => {
  const m = await load();
  const root = makeGroup("g", "horizontal", [
    makePane("a", ["t-a", "t-b"]),
    makePane("c", ["t-c"]),
  ]);
  assert.strictEqual(m.findPaneByTabId(root, "t-b")?.id, "a");
  assert.strictEqual(m.findPaneByTabId(root, "t-c")?.id, "c");
  assert.strictEqual(m.findPaneByTabId(root, "missing"), null);
});

test("findPanePath returns index paths", async () => {
  const m = await load();
  const tree = makeGroup("g", "horizontal", [
    makePane("a", []),
    makeGroup("g2", "vertical", [makePane("b", []), makePane("c", [])]),
  ]);
  assert.deepEqual(m.findPanePath(tree, "a"), [0]);
  assert.deepEqual(m.findPanePath(tree, "b"), [1, 0]);
  assert.deepEqual(m.findPanePath(tree, "missing"), null);
  assert.deepEqual(m.findPanePath(makePane("p", []), "p"), []);
});

test("collectPanes flattens depth-first", async () => {
  const m = await load();
  const a = makePane("a", []);
  const b = makePane("b", []);
  const c = makePane("c", []);
  const tree = makeGroup("g", "horizontal", [
    a,
    makeGroup("g2", "vertical", [b, c]),
  ]);
  const panes = m.collectPanes(tree);
  assert.equal(panes.length, 3);
  assert.equal(panes[0].id, "a");
  assert.equal(panes[1].id, "b");
  assert.equal(panes[2].id, "c");
  assert.deepEqual(m.collectPanes(null), []);
});

test("getTreeDepth measures deepest branch", async () => {
  const m = await load();
  assert.equal(m.getTreeDepth(makePane("p", [])), 1);
  const deep = makeGroup("g", "horizontal", [
    makePane("a", []),
    makeGroup("g2", "vertical", [
      makePane("b", []),
      makeGroup("g3", "horizontal", [makePane("c", []), makePane("d", [])]),
    ]),
  ]);
  assert.equal(m.getTreeDepth(deep), 4);
});

test("normalizeSizes and clampNormalizedSizes enforce MIN_SPLIT_SIZE = 0.2", async () => {
  const m = await load();
  assert.equal(m.MIN_SPLIT_SIZE, 0.2);
  const norm = m.normalizeSizes([1, 3], 2);
  assert.equal(norm.length, 2);
  const clamped = m.clampNormalizedSizes([0.02, 0.98]);
  assert.equal(clamped[0], 0.2);
  assert.equal(Math.abs(clamped[0] + clamped[1] - 1), 0);
  assert.deepEqual(m.normalizeSizes([2], 2), [2 / 3, 1 / 3]);
});

test("clampNormalizedSizes falls back to even when floor cannot be satisfied", async () => {
  const m = await load();
  const count = Math.ceil(1 / m.MIN_SPLIT_SIZE) + 1;
  const clamped = m.clampNormalizedSizes(
    Array.from({ length: count }, () => 1),
  );
  assert.deepEqual(
    clamped,
    Array.from({ length: count }, () => 1 / count),
  );
});

test("setGroupSizes applies clamping", async () => {
  const m = await load();
  const paneA = makePane("a", ["t"]);
  const paneB = makePane("b", ["t"]);
  const groupRoot = makeGroup("grp", "horizontal", [paneA, paneB]);
  const state2 = {
    root: groupRoot,
    sizesByGroupId: { grp: [0.5, 0.5] },
    focusedPaneId: "a",
  };
  const updated = m.setGroupSizes(state2, "grp", [0.95, 0.05]);
  assert.equal(updated.sizesByGroupId.grp?.length, 2);
  assert.equal(updated.sizesByGroupId.grp?.[0], 0.8);
  assert.equal(updated.sizesByGroupId.grp?.[1], 0.2);
});

test("addTabToPane adds tab and optionally activates", async () => {
  const m = await load();
  let state = m.createInitialTree("main");
  state = m.addTabToPane(state, "main", "t-1", { activate: false });
  assert.deepEqual(state.root.tabIds, ["t-1"]);
  assert.equal(state.root.activeTabId, "t-1");

  state = m.addTabToPane(state, "main", "t-2", { activate: true });
  assert.deepEqual(state.root.tabIds, ["t-1", "t-2"]);
  assert.equal(state.root.activeTabId, "t-2");
});

test("addTabToPane avoids duplicate tab ids", async () => {
  const m = await load();
  let state = m.createInitialTree("main");
  state = m.addTabToPane(state, "main", "t-1");
  state = m.addTabToPane(state, "main", "t-1");
  assert.deepEqual(state.root.tabIds, ["t-1"]);
});

test("removeTab updates pane and keeps structural identity of siblings", async () => {
  const m = await load();
  const paneA = makePane("a", ["t-a", "t-b"]);
  const sibling = makePane("b", ["t-b2"]);
  const root = makeGroup("grp", "horizontal", [paneA, sibling]);
  const state = { root, sizesByGroupId: {}, focusedPaneId: "a" };

  const afterRemove = m.removeTab(state, "t-a");
  assert.notStrictEqual(afterRemove, null);
  assert.deepEqual(afterRemove?.root.children[0].tabIds, ["t-b"]);
  assert.strictEqual(afterRemove?.root.children[1], sibling);
});

test("removeTab collapses empty non-root pane and promotes single child", async () => {
  const m = await load();
  const paneA = makePane("gone", ["t-gone"]);
  const survivorGroup = makeGroup("surv", "vertical", [
    makePane("s1", ["t-s1"]),
    makePane("s2", ["t-s2"]),
  ]);
  const root = makeGroup("root", "horizontal", [paneA, survivorGroup]);
  const state = {
    root,
    sizesByGroupId: { root: [0.5, 0.5], surv: [0.5, 0.5] },
    focusedPaneId: "gone",
  };

  const result = m.removeTab(state, "t-gone");
  assert.strictEqual(result?.root, survivorGroup);
  assert.deepEqual(result?.sizesByGroupId, { surv: [0.5, 0.5] });
  assert.strictEqual(result?.focusedPaneId, "s1");
});

test("removeTab keeps root empty when root pane is emptied", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  const withTab = m.addTabToPane(state, "main", "t");
  const afterRemove = m.removeTab(withTab, "t");
  assert.notStrictEqual(afterRemove, null);
  assert.equal(afterRemove?.root.kind, "pane");
  assert.equal(afterRemove?.root.id, "main");
  assert.deepEqual(afterRemove?.root.tabIds, []);
});

test("removeTab returns null for missing tab", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  assert.strictEqual(m.removeTab(state, "missing"), null);
});

test("moveTabToPane moves tab between panes", async () => {
  const m = await load();
  const paneA = makePane("a", ["t-a"]);
  const paneB = makePane("b", ["t-b"]);
  const root = makeGroup("grp", "horizontal", [paneA, paneB]);
  const state = { root, sizesByGroupId: {}, focusedPaneId: "a" };
  const moved = m.moveTabToPane(state, "t-a", "b");
  assert.notStrictEqual(moved, null);
  const paneAUpdated = m.findPaneById(moved?.root ?? root, "a");
  const paneBUpdated = m.findPaneById(moved?.root ?? root, "b");
  // Source pane "a" had its only tab moved out, so it was removed (not root).
  assert.strictEqual(paneAUpdated, null);
  assert.deepEqual(paneBUpdated?.tabIds, ["t-b", "t-a"]);
});

test("moveTabToPane returns null for missing source or target", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  assert.strictEqual(m.moveTabToPane(state, "missing", "main"), null);
  const withTab = m.addTabToPane(state, "main", "t");
  assert.strictEqual(m.moveTabToPane(withTab, "t", "missing"), null);
});

test("insertPaneAtEdge - same-direction merge splits target fraction", async () => {
  const m = await load();
  const target = makePane("a", ["t-a"]);
  const sibling = makePane("b", ["t-b"]);
  const tree = makeGroup("g", "horizontal", [target, sibling]);
  const state = {
    root: tree,
    sizesByGroupId: { g: [0.4, 0.6] },
    focusedPaneId: "a",
  };
  const result = m.insertPaneAtEdge(state, "a", "right", "new", "t-new");
  assert.notStrictEqual(result, null);
  assert.equal(result?.root.id, "g");
  assert.equal(result?.root.children.length, 3);
  assert.deepEqual(
    result?.root.children.map((c) => c.id),
    ["a", "new", "b"],
  );
  const sizes = result?.sizesByGroupId.g ?? [];
  assert.equal(sizes.length, 3);
  assert.ok(Math.abs(sizes[0] - 0.2) < 0.01);
  assert.ok(Math.abs(sizes[1] - 0.2) < 0.01);
  assert.ok(Math.abs(sizes[2] - 0.6) < 0.01);
});

test("insertPaneAtEdge - cross-direction wrap creates new group", async () => {
  const m = await load();
  const target = makePane("a", ["t-a"]);
  const state = { root: target, sizesByGroupId: {}, focusedPaneId: "a" };
  const result = m.insertPaneAtEdge(state, "a", "bottom", "new", "t-new");
  assert.notStrictEqual(result, null);
  assert.equal(result?.root.kind, "group");
  assert.equal(result?.root.direction, "vertical");
  assert.deepEqual(
    result?.sizesByGroupId[result?.root.id ?? ""] ?? [],
    [0.5, 0.5],
  );
});

test("insertPaneAtEdge rejects missing target or depth overflow", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  assert.strictEqual(
    m.insertPaneAtEdge(state, "missing", "right", "new", "t"),
    null,
  );
  // Build depth-MAX_TREE_DEPTH tree to trigger overflow.
  const deepestPane = makePane("d", ["t-d"]);
  const level3 = makeGroup("l3", "horizontal", [
    makePane("c", ["t-c"]),
    deepestPane,
  ]);
  const level2 = makeGroup("l2", "vertical", [makePane("b", ["t-b"]), level3]);
  const root = makeGroup("l1", "horizontal", [makePane("a", ["t-a"]), level2]);
  const depthState = { root, sizesByGroupId: {}, focusedPaneId: "d" };
  assert.equal(m.getTreeDepth(root), m.MAX_TREE_DEPTH);
  assert.strictEqual(
    m.insertPaneAtEdge(depthState, "d", "bottom", "new", "t-new"),
    null,
  );
});

test("setFocusedPane updates focusedPaneId", async () => {
  const m = await load();
  const state = m.createInitialTree("main");
  assert.equal(m.setFocusedPane(state, "other").focusedPaneId, "other");
});

test("applyPreset produces single pane with every tab", async () => {
  const m = await load();
  const state = m.applyPreset(m.createInitialTree("x"), "single", [
    "t-1",
    "t-2",
  ]);
  assert.equal(state.root.kind, "pane");
  assert.deepEqual(state.root.tabIds, ["t-1", "t-2"]);
  assert.equal(state.focusedPaneId, "preset-pane-0");
});

test("applyPreset produces columns (horizontal, one pane per tab)", async () => {
  const m = await load();
  const state = m.applyPreset(m.createInitialTree("x"), "columns", [
    "t-a",
    "t-b",
    "t-c",
  ]);
  assert.equal(state.root.kind, "group");
  assert.equal(state.root.direction, "horizontal");
  assert.equal(state.root.children.length, 3);
  assert.deepEqual(
    state.root.children.map((c) => c.id),
    ["preset-col-0", "preset-col-1", "preset-col-2"],
  );
  assert.deepEqual(state.sizesByGroupId["preset-columns"], [
    1 / 3,
    1 / 3,
    1 / 3,
  ]);
});

test("applyPreset produces grid (2 columns, column-major fill)", async () => {
  const m = await load();
  const state = m.applyPreset(m.createInitialTree("x"), "grid", [
    "t-1",
    "t-2",
    "t-3",
    "t-4",
    "t-5",
  ]);
  assert.equal(state.root.kind, "group");
  assert.equal(state.root.direction, "horizontal");
  assert.equal(state.root.children.length, 2);
  const leftCol = state.root.children[0];
  assert.equal(leftCol.kind, "group");
  assert.equal(leftCol.direction, "vertical");
  assert.equal(leftCol.children.length, 3); // ceil(5/2) = 3
  const rightCol = state.root.children[1];
  assert.equal(rightCol.children.length, 2);
  assert.deepEqual(state.sizesByGroupId["preset-grid"], [0.5, 0.5]);
});

test("applyPreset produces focus (first tab left at 0.58, rest vertical right)", async () => {
  const m = await load();
  const state = m.applyPreset(m.createInitialTree("x"), "focus", [
    "t-1",
    "t-2",
    "t-3",
  ]);
  assert.equal(state.root.kind, "group");
  assert.equal(state.root.direction, "horizontal");
  assert.equal(state.root.children.length, 2);
  assert.equal(state.root.children[0].id, "preset-focus-left");
  assert.deepEqual(state.root.children[0].tabIds, ["t-1"]);
  assert.equal(state.root.children[1].kind, "group");
  assert.equal(state.root.children[1].direction, "vertical");
  assert.deepEqual(state.sizesByGroupId["preset-focus"], [0.58, 0.42]);
  assert.equal(state.focusedPaneId, "preset-focus-left");
});

test("applyPreset handles single-tab focus as a single pane", async () => {
  const m = await load();
  const state = m.applyPreset(m.createInitialTree("x"), "focus", ["t-1"]);
  assert.equal(state.root.kind, "pane");
  assert.deepEqual(state.root.tabIds, ["t-1"]);
});

test("serializeTileTree produces versioned JSON and parseTileTree validates", async () => {
  const m = await load();
  const original = m.createInitialTree("main");
  const serialized = m.serializeTileTree(original);
  assert.equal(serialized.v, 1);
  const parsed = m.parseTileTree(serialized);
  assert.notStrictEqual(parsed, null);
  assert.equal(parsed?.root.id, "main");
  assert.equal(parsed?.focusedPaneId, "main");
});

test("parseTileTree rejects malformed input without throwing", async () => {
  const m = await load();
  assert.strictEqual(m.parseTileTree(null), null);
  assert.strictEqual(m.parseTileTree("string"), null);
  assert.strictEqual(m.parseTileTree({ v: 2 }), null);
  assert.strictEqual(m.parseTileTree({ v: 1, root: null }), null);
  assert.strictEqual(
    m.parseTileTree({ v: 1, root: { kind: "pane", id: 123 } }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({ v: 1, root: { kind: "pane", id: "x", tabIds: [1] } }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: { kind: "pane", id: "x", tabIds: ["a"], activeTabId: 42 },
    }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: {
        kind: "group",
        id: "g",
        direction: "horizontal",
        children: ["bad"],
      },
    }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: { kind: "group", id: "g", direction: "bad" },
    }),
    null,
  );
  assert.strictEqual(m.parseTileTree({ v: 1, root: { kind: "bad" } }), null);
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: { kind: "pane", id: "x", tabIds: ["a"], activeTabId: null },
      focusedPaneId: 42,
    }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: { kind: "pane", id: "x", tabIds: ["a"], activeTabId: null },
      sizesByGroupId: "not-obj",
    }),
    null,
  );
  assert.strictEqual(
    m.parseTileTree({
      v: 1,
      root: { kind: "pane", id: "x", tabIds: ["a"], activeTabId: null },
      sizesByGroupId: { bad: ["a"] },
    }),
    null,
  );
});

test("parseTileTree accepts valid nested group", async () => {
  const m = await load();
  const valid = {
    v: 1,
    root: {
      kind: "group",
      id: "g",
      direction: "horizontal",
      children: [{ kind: "pane", id: "a", tabIds: ["t"], activeTabId: "t" }],
    },
    sizesByGroupId: { g: [1] },
    focusedPaneId: "a",
  };
  const parsed = m.parseTileTree(valid);
  assert.notStrictEqual(parsed, null);
  assert.equal(parsed?.root.id, "g");
  assert.equal(parsed?.focusedPaneId, "a");
  assert.equal(parsed?.sizesByGroupId.g?.[0], 1);
});

test("insertPaneAtEdge allows null tabId to create empty pane", async () => {
  const m = await load();
  const target = makePane("a", ["t-a"]);
  const sibling = makePane("b", ["t-b"]);
  const tree = makeGroup("g", "horizontal", [target, sibling]);
  const state = { root: tree, sizesByGroupId: { g: [0.5, 0.5] }, focusedPaneId: "a" };
  const result = m.insertPaneAtEdge(state, "a", "right", "new-empty", null);
  assert.notStrictEqual(result, null);
  // Find the new pane by id in the result tree.
  const findPane = (node, id) => {
    if (node.kind === "pane" && node.id === id) return node;
    if (node.kind === "group") {
      for (const child of node.children) {
        const found = findPane(child, id);
        if (found) return found;
      }
    }
    return null;
  };
  const newPane = findPane(result?.root ?? null, "new-empty");
  assert.notStrictEqual(newPane, null);
  assert.equal(newPane?.kind, "pane");
  assert.equal(newPane?.id, "new-empty");
  assert.deepEqual(newPane?.tabIds, []);
  assert.equal(newPane?.activeTabId, null);
});
