import assert from "node:assert/strict";
import test from "node:test";

import {
  approverSpecNamesPubkey,
  selectOwnerWorkflowApprovalSources,
} from "./workflowApprovals.ts";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

test("approverSpecNamesPubkey matches only an exact hex pubkey", () => {
  assert.equal(approverSpecNamesPubkey(OWNER, OWNER), true);
  assert.equal(approverSpecNamesPubkey(OWNER.toUpperCase(), OWNER), true);
  assert.equal(approverSpecNamesPubkey(` ${OWNER} `, OWNER), true);
  assert.equal(approverSpecNamesPubkey(OTHER, OWNER), false);
});

test("approverSpecNamesPubkey rejects the relay's anyone-may-approve specs", () => {
  // The relay's own `check_approver_spec` treats `""` and `"any"` as "anyone
  // may approve" — not a specific person, so never "awaits the owner
  // specifically" no matter whose pubkey we compare against.
  assert.equal(approverSpecNamesPubkey("", OWNER), false);
  assert.equal(approverSpecNamesPubkey("any", OWNER), false);
  assert.equal(approverSpecNamesPubkey("ANY", OWNER), false);
});

test("approverSpecNamesPubkey rejects role-style specs the relay does not resolve to a pubkey", () => {
  assert.equal(approverSpecNamesPubkey("@engineering-lead", OWNER), false);
});

function workflow(id) {
  return { id, name: `Workflow ${id}`, ownerPubkey: OWNER, channelId: null };
}

function run(status) {
  return { id: "run-1", status, createdAt: 100, completedAt: null };
}

function approval(overrides = {}) {
  return {
    token: "token-1",
    stepId: "step-1",
    status: "pending",
    approverSpec: OWNER,
    ...overrides,
  };
}

test("selectOwnerWorkflowApprovalSources includes only a pending approval that names the owner", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [run("waiting_approval")],
    ownerPubkey: OWNER,
    pendingApprovals: [approval()],
    workflows: [workflow("workflow-1")],
    workflowsEnabled: true,
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].workflow.id, "workflow-1");
  assert.equal(sources[0].approval.token, "token-1");
});

test("selectOwnerWorkflowApprovalSources drops an approval open to anyone", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [run("waiting_approval")],
    ownerPubkey: OWNER,
    pendingApprovals: [approval({ approverSpec: "any" })],
    workflows: [workflow("workflow-1")],
    workflowsEnabled: true,
  });

  assert.deepEqual(sources, []);
});

test("selectOwnerWorkflowApprovalSources drops an approval addressed to someone else", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [run("waiting_approval")],
    ownerPubkey: OWNER,
    pendingApprovals: [approval({ approverSpec: OTHER })],
    workflows: [workflow("workflow-1")],
    workflowsEnabled: true,
  });

  assert.deepEqual(sources, []);
});

test("selectOwnerWorkflowApprovalSources drops every run when the workflows flag is off", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [run("waiting_approval")],
    ownerPubkey: OWNER,
    pendingApprovals: [approval()],
    workflows: [workflow("workflow-1")],
    workflowsEnabled: false,
  });

  assert.deepEqual(sources, []);
});

test("selectOwnerWorkflowApprovalSources drops run states that are not waiting on an approval", () => {
  for (const status of [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]) {
    const sources = selectOwnerWorkflowApprovalSources({
      latestRuns: [run(status)],
      ownerPubkey: OWNER,
      pendingApprovals: [approval()],
      workflows: [workflow("workflow-1")],
      workflowsEnabled: true,
    });
    assert.deepEqual(
      sources,
      [],
      `run status ${status} must not be a queue item`,
    );
  }
});

test("selectOwnerWorkflowApprovalSources drops a waiting run with no resolved approval yet", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [run("waiting_approval")],
    ownerPubkey: OWNER,
    pendingApprovals: [null],
    workflows: [workflow("workflow-1")],
    workflowsEnabled: true,
  });

  assert.deepEqual(sources, []);
});

test("selectOwnerWorkflowApprovalSources handles several workflows independently", () => {
  const sources = selectOwnerWorkflowApprovalSources({
    latestRuns: [
      run("waiting_approval"),
      run("running"),
      run("waiting_approval"),
    ],
    ownerPubkey: OWNER,
    pendingApprovals: [approval(), null, approval({ approverSpec: OTHER })],
    workflows: [workflow("mine"), workflow("running"), workflow("theirs")],
    workflowsEnabled: true,
  });

  assert.deepEqual(
    sources.map((source) => source.workflow.id),
    ["mine"],
  );
});
