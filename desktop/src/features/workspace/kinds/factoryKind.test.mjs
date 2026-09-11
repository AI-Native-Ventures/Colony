import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./factoryKind.tsx?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

test("factoryKindDefinition creates payload that parses as one empty pane", async () => {
  const kind = await load();
  const payload = kind.factoryKindDefinition.createPayload();
  const { parseTileTree } = await import("../../factory/lib/tileTree.ts");
  const parsed = parseTileTree(payload);
  assert.notStrictEqual(parsed, null);
  assert.equal(parsed?.root.kind, "pane");
  assert.deepEqual(parsed?.root.tabIds, []);
  assert.equal(parsed?.root.activeTabId, null);
  assert.equal(typeof parsed?.focusedPaneId, "string");
  assert.deepEqual(parsed?.sizesByGroupId, {});
});

test("isAvailable returns true for a project channel", async () => {
  const kind = await load();
  assert.strictEqual(
    kind.factoryKindDefinition.isAvailable({
      channelId: "project-ch",
      projects: [{ projectChannelId: "project-ch", id: "p", name: "P" }],
    }),
    true,
  );
});

test("isAvailable returns false for non-project channel", async () => {
  const kind = await load();
  assert.strictEqual(
    kind.factoryKindDefinition.isAvailable({
      channelId: "random",
      projects: [{ projectChannelId: "other", id: "p", name: "P" }],
    }),
    false,
  );
  assert.strictEqual(
    kind.factoryKindDefinition.isAvailable({
      channelId: "random",
      projects: undefined,
    }),
    false,
  );
});
