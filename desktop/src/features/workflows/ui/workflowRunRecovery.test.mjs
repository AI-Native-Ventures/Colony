import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableWorkflowRunStatus,
  workflowRunRecoveryLabel,
} from "./workflowRunRecovery.ts";

test("only failed and cancelled runs are retryable", () => {
  for (const status of ["failed", "cancelled"]) {
    assert.equal(isRetryableWorkflowRunStatus(status), true);
    assert.equal(workflowRunRecoveryLabel(status), "Run again");
  }
  for (const status of [
    "pending",
    "running",
    "completed",
    "waiting_approval",
  ]) {
    assert.equal(isRetryableWorkflowRunStatus(status), false);
    assert.equal(workflowRunRecoveryLabel(status), null);
  }
});
