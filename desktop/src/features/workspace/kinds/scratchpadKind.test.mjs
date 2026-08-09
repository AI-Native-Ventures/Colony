import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function load(run) {
  const module = await import(`./scratchpadKind.tsx?test=${importSequence++}`);
  await run(module);
}

test("a new scratchpad starts empty and untitled", async () => {
  await load((mod) => {
    assert.equal(mod.scratchpadKindDefinition.kind, "scratchpad");
    assert.equal(mod.scratchpadKindDefinition.canCreateFromNewTabPage, true);
    assert.deepEqual(mod.scratchpadKindDefinition.createPayload(), {
      text: "",
    });
    assert.equal(mod.scratchpadKindDefinition.createTitle(), "Untitled");
  });
});

test("reading text tolerates a payload from a different build", async () => {
  await load((mod) => {
    assert.equal(mod.readScratchpadText({ text: "hello" }), "hello");
    assert.equal(mod.readScratchpadText({ text: 42 }), "");
    assert.equal(mod.readScratchpadText(null), "");
    assert.equal(mod.readScratchpadText(undefined), "");
    assert.equal(mod.readScratchpadText("not an object"), "");
    assert.equal(mod.readScratchpadText({ other: "field" }), "");
  });
});
