import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectEmployeeHeads,
  parseEmployeeHead,
  parseRank,
  rankLabel,
  RANK_LABELS,
} from "./employeeHeads.ts";
import { KIND_EMPLOYEE } from "@/shared/constants/kinds.ts";

const PK = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const OTHER_PK =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function headEvent({
  pubkey = PK,
  rank = "worker",
  role = "sales-lead",
  name = "Sift",
  createdAt = 1_000,
}) {
  return {
    id: "e".repeat(64),
    pubkey,
    created_at: createdAt,
    kind: KIND_EMPLOYEE,
    tags: [
      ["d", pubkey],
      ["role", role],
      ["name", name],
      ["rank", rank],
      ["hired-by", OTHER_PK],
      ["e", "2".repeat(64)],
    ],
    content: "",
    sig: "f".repeat(128),
  };
}

test("labels are the exact product strings, never the enum casing", () => {
  assert.equal(rankLabel("worker"), "Worker");
  assert.equal(rankLabel("leader"), "Team lead");
  assert.equal(rankLabel("executive"), "Chief of staff");
  for (const label of Object.values(RANK_LABELS)) {
    assert.ok(!label.toLowerCase().includes("tier"), label);
  }
});

test("parseRank accepts only the pinned vocabulary", () => {
  assert.equal(parseRank("worker"), "worker");
  assert.equal(parseRank("leader"), "leader");
  assert.equal(parseRank("executive"), "executive");
  assert.equal(parseRank("owner"), null);
  assert.equal(parseRank("Worker"), null);
  assert.equal(parseRank(undefined), null);
});

test("a well-formed head parses to its identity and rank", () => {
  const parsed = parseEmployeeHead(headEvent({}));
  assert.deepEqual(parsed, {
    pubkey: PK,
    role: "sales-lead",
    name: "Sift",
    rank: "worker",
  });
});

test("malformed heads are dropped, not fatal", () => {
  assert.equal(parseEmployeeHead({ ...headEvent({}), kind: 9 }), null);
  const missingD = headEvent({});
  missingD.tags = missingD.tags.filter((tag) => tag[0] !== "d");
  assert.equal(parseEmployeeHead(missingD), null);
  const unknownRank = headEvent({ rank: "founder" });
  assert.equal(parseEmployeeHead(unknownRank), null);
  const badKey = headEvent({ pubkey: "not-a-key" });
  assert.equal(parseEmployeeHead(badKey), null);
});

test("the newest head per employee wins", () => {
  const promoted = headEvent({
    rank: "executive",
    createdAt: 2_000,
  });
  const heads = collectEmployeeHeads([headEvent({}), promoted]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].rank, "executive");
});

test("different employees stay separate rows", () => {
  const heads = collectEmployeeHeads([
    headEvent({}),
    headEvent({ pubkey: OTHER_PK, rank: "leader" }),
  ]);
  assert.equal(heads.length, 2);
  const byPubkey = new Map(heads.map((head) => [head.pubkey, head]));
  assert.equal(byPubkey.get(PK).rank, "worker");
  assert.equal(byPubkey.get(OTHER_PK).rank, "leader");
});

test("an older duplicate never shadows a newer head", () => {
  const heads = collectEmployeeHeads([
    headEvent({ rank: "executive", createdAt: 2_000 }),
    headEvent({ rank: "worker", createdAt: 1_000 }),
  ]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].rank, "executive");
});
