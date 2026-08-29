import assert from "node:assert/strict";
import test from "node:test";

import {
  filterByInitiative,
  itemInitiativeBucket,
  NO_INITIATIVE,
  selectInitiativeChips,
} from "./initiativeChips.ts";

function askItem(id, initiativeId, overrides = {}) {
  return {
    id: `ask:${id}`,
    kind: "ask",
    state: "needs-action",
    title: "An ask",
    summary: "",
    createdAt: 100,
    updatedAt: 100,
    capabilities: [],
    source: {
      kind: "ask",
      ask: { id, initiativeId, taskIds: ["task-1"] },
      deadlineAt: Infinity,
      isHardList: false,
    },
    ...overrides,
  };
}

function reminderItem(id) {
  return {
    id: `reminder:${id}`,
    kind: "reminder",
    state: "needs-action",
    title: "Reminder",
    summary: "",
    createdAt: 100,
    updatedAt: 100,
    capabilities: [],
    source: { kind: "reminder", reminder: { id } },
  };
}

test("itemInitiativeBucket: a real initiative id is its own bucket", () => {
  assert.equal(
    itemInitiativeBucket(askItem("a1", "website-relaunch")),
    "website-relaunch",
  );
});

test("itemInitiativeBucket: the no-initiative sentinel and a null value both bucket the same", () => {
  assert.equal(
    itemInitiativeBucket(askItem("a1", "no-initiative")),
    NO_INITIATIVE,
  );
  assert.equal(itemInitiativeBucket(askItem("a2", null)), NO_INITIATIVE);
});

test("itemInitiativeBucket: a non-ask item always buckets to no-initiative", () => {
  assert.equal(itemInitiativeBucket(reminderItem("r1")), NO_INITIATIVE);
});

test("selectInitiativeChips: fewer than two buckets renders no chips at all", () => {
  assert.deepEqual(
    selectInitiativeChips([askItem("a1", "website-relaunch")]),
    [],
  );
  assert.deepEqual(
    selectInitiativeChips([
      askItem("a1", "website-relaunch"),
      askItem("a2", "website-relaunch"),
    ]),
    [],
  );
});

test("selectInitiativeChips: named initiatives sort alphabetically, No initiative sorts last", () => {
  const items = [
    askItem("a1", "q3-hiring"),
    askItem("a2", "website-relaunch"),
    reminderItem("r1"),
  ];
  assert.deepEqual(selectInitiativeChips(items), [
    { id: "q3-hiring", label: "Q3 Hiring", count: 1 },
    { id: "website-relaunch", label: "Website Relaunch", count: 1 },
    { id: NO_INITIATIVE, label: "No initiative", count: 1 },
  ]);
});

test("selectInitiativeChips: counts every item in its bucket", () => {
  const items = [
    askItem("a1", "website-relaunch"),
    askItem("a2", "website-relaunch"),
    askItem("a3", "no-initiative"),
  ];
  assert.deepEqual(selectInitiativeChips(items), [
    { id: "website-relaunch", label: "Website Relaunch", count: 2 },
    { id: NO_INITIATIVE, label: "No initiative", count: 1 },
  ]);
});

test("filterByInitiative: null (the All chip) returns every item, order preserved", () => {
  const items = [askItem("a1", "x"), reminderItem("r1")];
  assert.deepEqual(filterByInitiative(items, null), items);
});

test("filterByInitiative: a specific chip keeps only its bucket, never regrouping", () => {
  const websiteAsk = askItem("a1", "website-relaunch");
  const hiringAsk = askItem("a2", "q3-hiring");
  const reminder = reminderItem("r1");
  const result = filterByInitiative(
    [websiteAsk, hiringAsk, reminder],
    "website-relaunch",
  );
  assert.deepEqual(result, [websiteAsk]);
});

test("filterByInitiative: the No initiative chip includes non-ask items and the sentinel together", () => {
  const namedAsk = askItem("a1", "website-relaunch");
  const sentinelAsk = askItem("a2", "no-initiative");
  const reminder = reminderItem("r1");
  const result = filterByInitiative(
    [namedAsk, sentinelAsk, reminder],
    NO_INITIATIVE,
  );
  assert.deepEqual(result, [sentinelAsk, reminder]);
});
