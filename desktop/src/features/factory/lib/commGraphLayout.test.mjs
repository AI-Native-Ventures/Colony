import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./commGraphLayout.ts?test=${Math.random()}`;

async function load() {
  return import(importPath);
}

const OWNER = { pubkey: "a".repeat(64), kind: "owner" };
const AGENTS = [
  { pubkey: "b".repeat(64), kind: "agent" },
  { pubkey: "c".repeat(64), kind: "agent" },
  { pubkey: "d".repeat(64), kind: "agent" },
];

test("owner sits left of every agent", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, ...AGENTS]);
  const owner = positions[0];
  assert.strictEqual(owner.pubkey, OWNER.pubkey);
  assert.strictEqual(owner.kind, "owner");
  for (const agent of positions.slice(1)) {
    assert.ok(
      agent.x > owner.x + owner.radius * 2,
      `agent x ${agent.x} should clear the owner at ${owner.x}`,
    );
  }
});

test("every node and its labels stay inside the viewBox", async () => {
  const m = await load();
  for (let count = 1; count <= 8; count += 1) {
    const nodes = [
      OWNER,
      ...Array.from({ length: count }, (_unused, index) => ({
        pubkey: String(index).repeat(64),
        kind: "agent",
      })),
    ];
    const layout = m.layoutCommGraph(nodes);
    assert.strictEqual(layout.viewBox, `0 0 ${layout.width} ${layout.height}`);
    for (const position of layout.positions) {
      assert.ok(position.x - position.radius >= 0, "left edge");
      assert.ok(position.x + position.radius <= layout.width, "right edge");
      assert.ok(position.y - position.radius >= 0, "top edge");
      assert.ok(position.roleY <= layout.height, "role label bottom edge");
      assert.ok(
        position.nameY > position.y + position.radius,
        "name below node",
      );
      assert.ok(position.roleY > position.nameY, "role below name");
    }
  }
});

test("a lone agent sits level with the owner", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, AGENTS[0]]);
  assert.strictEqual(positions[1].y, positions[0].y);
});

test("agents spread vertically and keep their input order", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, ...AGENTS]);
  assert.deepStrictEqual(
    positions.slice(1).map((position) => position.pubkey),
    AGENTS.map((agent) => agent.pubkey),
  );
  assert.ok(positions[1].y < positions[2].y);
  assert.ok(positions[2].y < positions[3].y);
});

test("layout is deterministic", async () => {
  const m = await load();
  assert.deepStrictEqual(
    m.layoutCommGraph([OWNER, ...AGENTS]),
    m.layoutCommGraph([OWNER, ...AGENTS]),
  );
});

test("an edge starts and ends outside both node circles", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, ...AGENTS]);
  const [from, to] = [positions[0], positions[1]];
  const geometry = m.commGraphEdgeGeometry(from, to);
  const [, startX, startY] = geometry.path.match(/^M (\S+) (\S+) Q/);
  const [, endX, endY] = geometry.path.match(/Q \S+ \S+ (\S+) (\S+)$/);
  assert.ok(
    Math.hypot(Number(startX) - from.x, Number(startY) - from.y) >=
      from.radius - 0.01,
  );
  assert.ok(
    Math.hypot(Number(endX) - to.x, Number(endY) - to.y) > to.radius,
    "the target end leaves room for the arrow marker",
  );
});

test("the two directions of a pair bow to opposite sides", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, ...AGENTS]);
  const [a, b] = [positions[0], positions[1]];
  const forward = m.commGraphEdgeGeometry(a, b);
  const back = m.commGraphEdgeGeometry(b, a);
  assert.notStrictEqual(forward.path, back.path);

  // Which side of the straight a↔b line a label sits on, as the sign of the
  // cross product. Opposite signs means the two curves bow apart whatever
  // angle the pair happens to sit at.
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const side = (geometry) =>
    Math.sign(
      (b.x - a.x) * (geometry.labelY - midY) -
        (b.y - a.y) * (geometry.labelX - midX),
    );
  assert.notStrictEqual(side(forward), 0);
  assert.strictEqual(side(forward), -side(back));
});

test("a degenerate zero-length edge does not produce NaN", async () => {
  const m = await load();
  const { positions } = m.layoutCommGraph([OWNER, AGENTS[0]]);
  const geometry = m.commGraphEdgeGeometry(positions[0], positions[0]);
  assert.ok(!geometry.path.includes("NaN"));
  assert.ok(Number.isFinite(geometry.labelX));
  assert.ok(Number.isFinite(geometry.labelY));
});
