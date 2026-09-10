import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./projectChannel.ts?test=${Math.random()}`;

async function load() {
  const module = await import(importPath);
  return module;
}

test("findProjectForChannel finds matching project", async () => {
  const m = await load();
  const projects = [
    { projectChannelId: "ch-1", id: "p1", name: "Project A" },
    { projectChannelId: "ch-2", id: "p2", name: "Project B" },
  ];
  assert.strictEqual(m.findProjectForChannel(projects, "ch-1")?.id, "p1");
  assert.strictEqual(m.findProjectForChannel(projects, "ch-2")?.id, "p2");
});

test("findProjectForChannel returns null for missing or undefined", async () => {
  const m = await load();
  assert.strictEqual(m.findProjectForChannel(undefined, "ch-1"), null);
  assert.strictEqual(
    m.findProjectForChannel([{ projectChannelId: "ch-1", id: "p" }], "missing"),
    null,
  );
});

test("isProjectChannel returns true for project channel", async () => {
  const m = await load();
  assert.strictEqual(
    m.isProjectChannel([{ projectChannelId: "ch-1", id: "p" }], "ch-1"),
    true,
  );
  assert.strictEqual(
    m.isProjectChannel([{ projectChannelId: "ch-1", id: "p" }], "other"),
    false,
  );
});
