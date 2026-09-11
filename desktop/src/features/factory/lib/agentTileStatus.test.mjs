import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./agentTileStatus.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

test("a running agent mid-turn is working, otherwise idle", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, true),
    "working",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, false),
    "idle",
  );
});

test("a deployed agent follows the same working/idle split", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "deployed" }, true),
    "working",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "deployed" }, false),
    "idle",
  );
});

test("a not-yet-deployed record reads as deploying", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "not_deployed" }, false),
    "deploying",
  );
});

test("anything else is stopped, even with a stale tracked turn", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "stopped" }, false),
    "stopped",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "stopped" }, true),
    "stopped",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "wat" }, true),
    "stopped",
  );
});

test("an open ask outranks every other state", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, true, true),
    "needs-you",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, false, true),
    "needs-you",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "stopped" }, false, true),
    "needs-you",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "not_deployed" }, false, true),
    "needs-you",
  );
});

test("no open ask leaves the derivation exactly as it was", async () => {
  const m = await load();
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, true, false),
    "working",
  );
  assert.strictEqual(
    m.deriveAgentTileStatus({ status: "running" }, false, false),
    "idle",
  );
});

test("every status has a pill label", async () => {
  const m = await load();
  assert.deepStrictEqual(Object.keys(m.AGENT_TILE_STATUS_LABEL).sort(), [
    "deploying",
    "idle",
    "needs-you",
    "stopped",
    "working",
  ]);
});
