import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./commGraph.ts?test=${Math.random()}`;

async function load() {
  return import(importPath);
}

const OWNER = "a".repeat(64);
const AVERY = "b".repeat(64);
const VERA = "c".repeat(64);
const STRANGER = "d".repeat(64);

const NOW = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW / 1_000);

function message({
  id,
  pubkey,
  content = "hello",
  mentions = [],
  at = NOW_SECONDS - 60,
  kind = 9,
  root = null,
  parent = null,
}) {
  const tags = [["h", "channel-1"]];
  if (parent) tags.push(["p", pubkey]);
  for (const mention of mentions) tags.push(["p", mention]);
  if (root && parent && root !== parent) {
    tags.push(["e", root, "", "root"]);
    tags.push(["e", parent, "", "reply"]);
  } else if (parent) {
    tags.push(["e", parent, "", "reply"]);
  }
  return {
    id,
    pubkey,
    created_at: at,
    kind,
    tags,
    content,
    sig: "sig",
  };
}

function build(m, overrides = {}) {
  return m.buildCommGraph({
    events: [],
    ownerPubkey: OWNER,
    agentPubkeys: [AVERY, VERA],
    openAsks: [],
    windowMs: 30 * 60 * 1_000,
    now: NOW,
    ...overrides,
  });
}

test("owner is the first node and every known agent is kept", async () => {
  const m = await load();
  const graph = build(m);
  assert.deepStrictEqual(graph.nodes[0], { pubkey: OWNER, kind: "owner" });
  assert.deepStrictEqual(
    [...graph.nodes.slice(1)].map((node) => node.kind),
    ["agent", "agent"],
  );
  assert.deepStrictEqual(
    graph.nodes.map((node) => node.pubkey).sort(),
    [OWNER, AVERY, VERA].sort(),
  );
  assert.deepStrictEqual(graph.edges, []);
});

test("a mention becomes a counted edge from author to mentioned", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({ id: "e1", pubkey: OWNER, mentions: [AVERY] }),
      message({ id: "e2", pubkey: OWNER, mentions: [AVERY] }),
      message({ id: "e3", pubkey: AVERY, mentions: [OWNER], at: NOW_SECONDS }),
    ],
  });
  const forward = graph.edges.find(
    (edge) => edge.from === OWNER && edge.to === AVERY,
  );
  const back = graph.edges.find(
    (edge) => edge.from === AVERY && edge.to === OWNER,
  );
  assert.strictEqual(forward.count, 2);
  assert.strictEqual(forward.kind, "message");
  assert.strictEqual(back.count, 1);
  assert.strictEqual(back.lastAt, NOW_SECONDS);
});

test("a thread reply edges to the thread root's author", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({ id: "root", pubkey: AVERY, content: "ship it" }),
      message({ id: "r1", pubkey: VERA, parent: "root", root: "root" }),
    ],
  });
  const edge = graph.edges.find(
    (candidate) => candidate.from === VERA && candidate.to === AVERY,
  );
  assert.strictEqual(edge.count, 1);
  assert.strictEqual(graph.interactions.at(-1).rootId, "root");
});

test("self mentions, strangers and out-of-window messages are dropped", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({ id: "self", pubkey: AVERY, mentions: [AVERY] }),
      message({ id: "stranger", pubkey: STRANGER, mentions: [OWNER] }),
      message({ id: "to-stranger", pubkey: OWNER, mentions: [STRANGER] }),
      message({
        id: "old",
        pubkey: OWNER,
        mentions: [AVERY],
        at: NOW_SECONDS - 31 * 60,
      }),
    ],
  });
  assert.deepStrictEqual(graph.edges, []);
  assert.deepStrictEqual(graph.interactions, []);
});

test("a wider window lets an older message back in", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({
        id: "old",
        pubkey: OWNER,
        mentions: [AVERY],
        at: NOW_SECONDS - 31 * 60,
      }),
    ],
    windowMs: 2 * 60 * 60 * 1_000,
  });
  assert.strictEqual(graph.edges.length, 1);
});

test("an open ask an agent raised is a dashed ask edge to the owner", async () => {
  const m = await load();
  const graph = build(m, {
    openAsks: [
      {
        id: "ask-1",
        filerPubkey: VERA,
        createdAt: NOW_SECONDS - 10 * 60 * 60,
        headline: "Force-push rebased feat/billing-export?\nsecond line",
        threadId: "thread-9",
      },
      {
        id: "ask-owner",
        filerPubkey: OWNER,
        createdAt: NOW_SECONDS,
        headline: "owner asks are not agent asks",
        threadId: null,
      },
    ],
  });
  assert.strictEqual(graph.edges.length, 1);
  assert.deepStrictEqual(
    { ...graph.edges[0] },
    {
      from: VERA,
      to: OWNER,
      count: 1,
      lastAt: NOW_SECONDS - 10 * 60 * 60,
      kind: "ask",
    },
  );
  // An ask that is still open is outstanding now, so the message window does
  // not hide it.
  assert.strictEqual(
    graph.interactions[0].text,
    "Force-push rebased feat/billing-export?",
  );
  assert.strictEqual(graph.interactions[0].rootId, "thread-9");
});

test("edit events count and mixed-case pubkeys normalise", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({
        id: "edit",
        pubkey: OWNER.toUpperCase(),
        mentions: [AVERY.toUpperCase()],
        kind: 40003,
      }),
      message({ id: "v2", pubkey: OWNER, mentions: [AVERY], kind: 40002 }),
    ],
  });
  assert.strictEqual(graph.edges.length, 1);
  assert.strictEqual(graph.edges[0].count, 2);
  assert.strictEqual(graph.edges[0].from, OWNER);
});

test("node, edge and interaction order is deterministic", async () => {
  const m = await load();
  const events = [
    message({ id: "e2", pubkey: VERA, mentions: [OWNER], at: NOW_SECONDS - 5 }),
    message({ id: "e1", pubkey: OWNER, mentions: [VERA], at: NOW_SECONDS - 9 }),
    message({
      id: "e3",
      pubkey: OWNER,
      mentions: [AVERY],
      at: NOW_SECONDS - 5,
    }),
  ];
  const first = build(m, { events });
  const second = build(m, { events: [...events].reverse() });
  assert.deepStrictEqual(first.nodes, second.nodes);
  assert.deepStrictEqual(first.edges, second.edges);
  assert.deepStrictEqual(first.interactions, second.interactions);
  // Busiest agent first: Vera carries two interactions, Avery one.
  assert.deepStrictEqual(
    first.nodes.map((node) => node.pubkey),
    [OWNER, VERA, AVERY],
  );
  assert.deepStrictEqual(
    first.interactions.map((interaction) => interaction.id),
    ["e1", "e2", "e3"],
  );
});

test("pairInteractions returns both directions and nothing else", async () => {
  const m = await load();
  const graph = build(m, {
    events: [
      message({ id: "e1", pubkey: OWNER, mentions: [AVERY] }),
      message({ id: "e2", pubkey: AVERY, mentions: [OWNER] }),
      message({ id: "e3", pubkey: OWNER, mentions: [VERA] }),
    ],
  });
  assert.deepStrictEqual(
    m.pairInteractions(graph, AVERY, OWNER).map((item) => item.id),
    ["e1", "e2"],
  );
  assert.deepStrictEqual(m.pairInteractions(graph, AVERY, VERA), []);
});
