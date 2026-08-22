import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOrgTree } from "./orgTree.ts";

const EXEC = "1111111111111111111111111111111111111111111111111111111111111111";
const LEAD = "2222222222222222222222222222222222222222222222222222222222222222";
const WORKER =
  "3333333333333333333333333333333333333333333333333333333333333333";
const WORKER2 =
  "4444444444444444444444444444444444444444444444444444444444444444";
const GHOST =
  "5555555555555555555555555555555555555555555555555555555555555555";

function member({ pubkey, rank, manager = null, name = pubkey.slice(0, 4) }) {
  return { pubkey, name, role: "role", rank, manager };
}

function flatten(node, acc = []) {
  acc.push(node.member.pubkey);
  for (const report of node.reports) flatten(report, acc);
  return acc;
}

test("the empty case builds nothing", () => {
  assert.deepEqual(buildOrgTree([]), { roots: [], unassigned: [] });
});

test("executives are roots and several executives means several roots", () => {
  const tree = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive" }),
    member({ pubkey: LEAD, rank: "executive", name: "aaaa" }),
  ]);
  assert.equal(tree.roots.length, 2);
  assert.deepEqual(tree.unassigned, []);
});

test("a full chain nests under its executive root", () => {
  const tree = buildOrgTree([
    member({ pubkey: WORKER, rank: "worker", manager: LEAD }),
    member({ pubkey: LEAD, rank: "leader", manager: EXEC }),
    member({ pubkey: EXEC, rank: "executive" }),
  ]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].member.pubkey, EXEC);
  assert.equal(tree.roots[0].reports[0].member.pubkey, LEAD);
  assert.equal(tree.roots[0].reports[0].reports[0].member.pubkey, WORKER);
  assert.deepEqual(tree.unassigned, []);
});

test("an orphan whose manager points at a deleted agent stays visible in the tray", () => {
  const tree = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive" }),
    member({ pubkey: WORKER, rank: "worker", manager: GHOST }),
  ]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.unassigned.length, 1);
  assert.equal(tree.unassigned[0].member.pubkey, WORKER);
});

test("workers and leaders with no manager land in the unassigned tray", () => {
  const tree = buildOrgTree([
    member({ pubkey: LEAD, rank: "leader" }),
    member({ pubkey: WORKER, rank: "worker" }),
  ]);
  assert.deepEqual(tree.roots, []);
  assert.deepEqual(
    tree.unassigned.map((node) => node.member.pubkey).sort(),
    [LEAD, WORKER].sort(),
  );
});

test("a worker whose manager is itself unassigned stays nested under that manager", () => {
  // The leader has no manager, so it tops the tray; its worker keeps its
  // reporting line and renders beneath it. Nobody is dropped and nobody
  // appears twice.
  const tree = buildOrgTree([
    member({ pubkey: WORKER, rank: "worker", manager: LEAD }),
    member({ pubkey: LEAD, rank: "leader" }),
    member({ pubkey: EXEC, rank: "executive" }),
  ]);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.unassigned.length, 1);
  assert.equal(tree.unassigned[0].member.pubkey, LEAD);
  assert.deepEqual(flatten(tree.unassigned[0]), [LEAD, WORKER]);
  const placed = [...flatten(tree.roots[0]), ...flatten(tree.unassigned[0])];
  assert.equal(new Set(placed).size, placed.length, "no agent appears twice");
});

test("an edge the relay would reject does not become a branch", () => {
  // A worker claiming a worker as manager is a skipped-rung edge; the relay
  // refuses it at ingest, so the builder treats it as unresolved.
  const tree = buildOrgTree([
    member({ pubkey: WORKER, rank: "worker", manager: WORKER2 }),
    member({ pubkey: WORKER2, rank: "worker" }),
    member({ pubkey: EXEC, rank: "executive" }),
  ]);
  assert.equal(
    tree.unassigned
      .map((node) => node.member.pubkey)
      .sort()
      .join(","),
    [WORKER, WORKER2].sort().join(","),
  );
});

test("an executive carrying a manager tag is still a root", () => {
  const tree = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive", manager: LEAD }),
    member({ pubkey: LEAD, rank: "leader" }),
  ]);
  // There is no rank above an executive, so the relay would refuse this
  // edge at ingest; the builder resolves it to no edge and keeps the
  // executive a root. The managerless leader tops the tray.
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].member.pubkey, EXEC);
  assert.equal(tree.unassigned.length, 1);
  assert.equal(tree.unassigned[0].member.pubkey, LEAD);
});

test("a manager cycle must terminate and stay visible", () => {
  // Rank geometry makes a true cycle unrepresentable (every valid edge climbs
  // exactly one rung), but the builder must not trust that at render time.
  // The closest hostile input: two members pointing at each other. Every edge
  // fails the rung check, so both land in the tray and the build returns.
  const tree = buildOrgTree([
    member({ pubkey: WORKER, rank: "worker", manager: WORKER2 }),
    member({ pubkey: WORKER2, rank: "worker", manager: WORKER }),
  ]);
  assert.deepEqual(
    tree.unassigned.map((node) => node.member.pubkey).sort(),
    [WORKER, WORKER2].sort(),
  );
});

test("duplicate pubkeys collapse to one node", () => {
  const tree = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive" }),
    member({ pubkey: EXEC, rank: "executive", name: "dupe" }),
  ]);
  assert.equal(tree.roots.length, 1);
});

test("ordering is deterministic", () => {
  const first = buildOrgTree([
    member({ pubkey: WORKER, rank: "worker", manager: LEAD, name: "zeta" }),
    member({ pubkey: WORKER2, rank: "worker", manager: LEAD, name: "alpha" }),
    member({ pubkey: LEAD, rank: "leader", manager: EXEC }),
    member({ pubkey: EXEC, rank: "executive" }),
  ]);
  const second = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive" }),
    member({ pubkey: LEAD, rank: "leader", manager: EXEC }),
    member({ pubkey: WORKER2, rank: "worker", manager: LEAD, name: "alpha" }),
    member({ pubkey: WORKER, rank: "worker", manager: LEAD, name: "zeta" }),
  ]);
  assert.deepEqual(flatten(first.roots[0]), flatten(second.roots[0]));
  assert.deepEqual(flatten(first.roots[0]), [EXEC, LEAD, WORKER2, WORKER]);
});

test("counts report direct span and everyone underneath", () => {
  const tree = buildOrgTree([
    member({ pubkey: EXEC, rank: "executive" }),
    member({ pubkey: LEAD, rank: "leader", manager: EXEC }),
    member({ pubkey: WORKER, rank: "worker", manager: LEAD }),
    member({ pubkey: WORKER2, rank: "worker", manager: LEAD }),
  ]);

  const [exec] = tree.roots;
  // The executive manages one lead directly but carries three underneath:
  // that difference is the whole point of tracking both.
  assert.equal(exec.counts.directReports, 1);
  assert.equal(exec.counts.totalReports, 3);

  const [lead] = exec.reports;
  assert.equal(lead.counts.directReports, 2);
  assert.equal(lead.counts.totalReports, 2);

  for (const worker of lead.reports) {
    assert.equal(worker.counts.directReports, 0);
    assert.equal(worker.counts.totalReports, 0);
  }
});

test("counts hold for members in the unassigned tray", () => {
  const tree = buildOrgTree([
    member({ pubkey: LEAD, rank: "leader" }),
    member({ pubkey: WORKER, rank: "worker", manager: LEAD }),
  ]);

  // A lead with no manager is unplaced, but its own reports still resolve
  // beneath it, so its span of control must still be visible.
  assert.equal(tree.roots.length, 0);
  assert.equal(tree.unassigned.length, 1);
  assert.equal(tree.unassigned[0].counts.directReports, 1);
  assert.equal(tree.unassigned[0].counts.totalReports, 1);
});
