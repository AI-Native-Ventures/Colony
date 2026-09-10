import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./agentTileAsks.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

const AGENT = "a".repeat(64);
const OTHER = "b".repeat(64);
const RELAY = "c".repeat(64);

test("an agent owns the asks it filed, and nobody else's", async () => {
  const m = await load();
  const asks = [
    { id: "1", filerPubkey: AGENT },
    { id: "2", filerPubkey: OTHER },
    { id: "3", filerPubkey: AGENT },
  ];
  assert.deepStrictEqual(
    m.openAsksForAgent(asks, AGENT).map((ask) => ask.id),
    ["1", "3"],
  );
});

test("a promoted ask stays with the original filer, not the relay", async () => {
  const m = await load();
  const asks = [
    { id: "1", filerPubkey: RELAY, originalFilerPubkey: AGENT },
    { id: "2", filerPubkey: RELAY, originalFilerPubkey: OTHER },
  ];
  assert.deepStrictEqual(
    m.openAsksForAgent(asks, AGENT).map((ask) => ask.id),
    ["1"],
  );
  assert.deepStrictEqual(m.openAsksForAgent(asks, RELAY), []);
});

test("ownership is case- and whitespace-insensitive", async () => {
  const m = await load();
  const asks = [{ id: "1", filerPubkey: AGENT.toUpperCase() }];
  assert.strictEqual(m.openAsksForAgent(asks, ` ${AGENT} `).length, 1);
});

test("a tile with no agent pubkey owns nothing", async () => {
  const m = await load();
  assert.deepStrictEqual(
    m.openAsksForAgent([{ id: "1", filerPubkey: AGENT }], ""),
    [],
  );
});

test("the lookup set names only the agents that raised something", async () => {
  const m = await load();
  const set = m.agentPubkeysWithOpenAsks(
    [{ filerPubkey: AGENT.toUpperCase() }],
    [AGENT, OTHER, ""],
  );
  assert.deepStrictEqual([...set], [AGENT]);
});
