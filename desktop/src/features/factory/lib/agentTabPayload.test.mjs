import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./agentTabPayload.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

test("createAgentTabPayload defaults the thread to null", async () => {
  const m = await load();
  assert.deepStrictEqual(m.createAgentTabPayload("abc"), {
    v: 1,
    agentPubkey: "abc",
    threadRootId: null,
  });
  assert.deepStrictEqual(m.createAgentTabPayload("abc", "root"), {
    v: 1,
    agentPubkey: "abc",
    threadRootId: "root",
  });
});

test("parseAgentTabPayload round-trips a created payload", async () => {
  const m = await load();
  const payload = m.createAgentTabPayload("abc", "root");
  assert.deepStrictEqual(
    m.parseAgentTabPayload(JSON.parse(JSON.stringify(payload))),
    payload,
  );
});

test("parseAgentTabPayload rejects malformed values", async () => {
  const m = await load();
  for (const value of [
    null,
    undefined,
    "agent",
    42,
    [],
    {},
    { v: 2, agentPubkey: "abc", threadRootId: null },
    { v: 1, threadRootId: null },
    { v: 1, agentPubkey: "", threadRootId: null },
    { v: 1, agentPubkey: 7, threadRootId: null },
    { v: 1, agentPubkey: "abc", threadRootId: 7 },
    { v: 1, agentPubkey: "abc", threadRootId: "" },
  ]) {
    assert.strictEqual(
      m.parseAgentTabPayload(value),
      null,
      `expected null for ${JSON.stringify(value)}`,
    );
  }
});

test("parseAgentTabPayload accepts a missing thread as null", async () => {
  const m = await load();
  assert.deepStrictEqual(m.parseAgentTabPayload({ v: 1, agentPubkey: "abc" }), {
    v: 1,
    agentPubkey: "abc",
    threadRootId: null,
  });
});

test("withThreadRootId binds a thread and is identity when unchanged", async () => {
  const m = await load();
  const payload = m.createAgentTabPayload("abc");
  const bound = m.withThreadRootId(payload, "root");
  assert.deepStrictEqual(bound, {
    v: 1,
    agentPubkey: "abc",
    threadRootId: "root",
  });
  assert.strictEqual(m.withThreadRootId(bound, "root"), bound);
});

test("collectAgentTabPubkeys counts agent tabs the tree holds, once each", async () => {
  const m = await load();
  const tabs = [
    { id: "t1", kind: "agent", payload: m.createAgentTabPayload("aa") },
    { id: "t2", kind: "terminal", payload: { sessionKey: null } },
    { id: "t3", kind: "agent", payload: m.createAgentTabPayload("bb") },
    // Same agent in a second tile: one agent, not two.
    { id: "t4", kind: "agent", payload: m.createAgentTabPayload("aa") },
    // In the workspace but dragged out of this tree.
    { id: "t5", kind: "agent", payload: m.createAgentTabPayload("cc") },
    { id: "t6", kind: "agent", payload: { broken: true } },
  ];
  assert.deepStrictEqual(
    m.collectAgentTabPubkeys(tabs, ["t1", "t2", "t3", "t4", "t6"]),
    ["aa", "bb"],
  );
  assert.deepStrictEqual(m.collectAgentTabPubkeys(tabs, []), []);
});
