import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function freshRegistry(run) {
  const module = await import(`./tabKindRegistry.ts?test=${importSequence++}`);
  module.clearTabKindRegistry();
  await run(module);
}

const stubKind = {
  kind: "stub",
  label: "Stub",
  createTitle: () => "Stub tab",
  createPayload: () => ({ stub: true }),
  canCreateFromNewTabPage: false,
};

test("an unregistered kind resolves to undefined rather than throwing", async () => {
  await freshRegistry((mod) => {
    assert.equal(mod.getTabKind("nope"), undefined);
  });
});

test("a kind the UI never ships still registers and resolves", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    const found = mod.getTabKind("stub");
    assert.equal(found.label, "Stub");
    assert.deepEqual(found.createPayload(), { stub: true });
  });
});

test("the new-tab page only offers kinds that opt in", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    mod.registerTabKind({
      kind: "scratchpad",
      label: "Scratchpad",
      createTitle: () => "Untitled",
      createPayload: () => ({ text: "" }),
      canCreateFromNewTabPage: true,
    });
    assert.deepEqual(
      mod.listCreatableTabKinds().map((definition) => definition.kind),
      ["scratchpad"],
      "the stub kind must not appear in shipped UI",
    );
  });
});

test("registering the same kind twice is rejected", async () => {
  await freshRegistry((mod) => {
    mod.registerTabKind(stubKind);
    assert.throws(
      () => mod.registerTabKind(stubKind),
      /already registered/,
      "a duplicate kind is a programming error, not a silent overwrite",
    );
  });
});

test("creatable kinds keep registration order", async () => {
  await freshRegistry((mod) => {
    for (const kind of ["a", "b", "c"]) {
      mod.registerTabKind({
        kind,
        label: kind.toUpperCase(),
        createTitle: () => kind,
        createPayload: () => ({}),
        canCreateFromNewTabPage: true,
      });
    }
    assert.deepEqual(
      mod.listCreatableTabKinds().map((definition) => definition.kind),
      ["a", "b", "c"],
    );
  });
});
