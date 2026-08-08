import assert from "node:assert/strict";
import test from "node:test";

import { PIPELINE_COLUMN_STATUSES } from "../types.ts";
import {
  canMoveLead,
  pipelineMoveTargets,
  PIPELINE_COLUMN_LABELS,
  relationshipLabel,
} from "./pipelineTransitions.ts";

test("columns run in lifecycle order: entry to terminal to client", () => {
  assert.deepEqual(PIPELINE_COLUMN_STATUSES, [
    "candidate",
    "accepted",
    "qualified",
    "dormant",
    "disqualified",
    "client_active",
  ]);
  assert.deepEqual(
    PIPELINE_COLUMN_STATUSES.map((status) => PIPELINE_COLUMN_LABELS[status]),
    [
      "Candidate",
      "Accepted",
      "Qualified",
      "Dormant",
      "Disqualified",
      "Converted",
    ],
  );
});

test("the move mirror matches the relay's transition matrix", () => {
  const legal = [
    ["candidate", "accepted"],
    ["candidate", "disqualified"],
    ["accepted", "qualified"],
    ["accepted", "dormant"],
    ["accepted", "disqualified"],
    ["qualified", "dormant"],
    ["qualified", "disqualified"],
    ["dormant", "qualified"],
    ["dormant", "disqualified"],
  ];
  for (const [from, to] of legal) {
    assert.equal(
      canMoveLead(from, to),
      true,
      `${from} -> ${to} must be allowed`,
    );
  }
  const illegal = [
    ["candidate", "qualified"],
    ["candidate", "dormant"],
    ["qualified", "accepted"],
    ["qualified", "candidate"],
    ["dormant", "accepted"],
    ["dormant", "candidate"],
    ["disqualified", "accepted"],
    ["disqualified", "candidate"],
    ["disqualified", "qualified"],
    ["disqualified", "dormant"],
    ["accepted", "candidate"],
    ["candidate", "client_active"],
    ["accepted", "client_active"],
    ["qualified", "client_active"],
    ["dormant", "client_active"],
    ["disqualified", "client_active"],
  ];
  for (const [from, to] of illegal) {
    assert.equal(
      canMoveLead(from, to),
      false,
      `${from} -> ${to} must be refused`,
    );
  }
});

test("same-status is allowed so content edits do not need a transition", () => {
  for (const status of [
    "candidate",
    "accepted",
    "qualified",
    "dormant",
    "disqualified",
  ]) {
    assert.equal(canMoveLead(status, status), true);
  }
});

test("move targets exclude the current status and stay in lifecycle order", () => {
  assert.deepEqual(pipelineMoveTargets("candidate"), [
    "accepted",
    "disqualified",
  ]);
  assert.deepEqual(pipelineMoveTargets("accepted"), [
    "qualified",
    "dormant",
    "disqualified",
  ]);
  assert.deepEqual(pipelineMoveTargets("qualified"), [
    "dormant",
    "disqualified",
  ]);
  assert.deepEqual(pipelineMoveTargets("dormant"), [
    "qualified",
    "disqualified",
  ]);
  assert.deepEqual(
    pipelineMoveTargets("disqualified"),
    [],
    "disqualified is terminal",
  );
  assert.deepEqual(
    pipelineMoveTargets("client_active"),
    [],
    "Converted is read-only in this phase",
  );
});

test("the relay refusal label uses the relationship vocabulary", () => {
  assert.equal(relationshipLabel("candidate"), "Candidate");
  assert.equal(relationshipLabel("disqualified"), "Disqualified");
  assert.equal(relationshipLabel("client_active"), "Active");
});
