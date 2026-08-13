import type { WorkflowRunStatus } from "@/shared/api/types";

/** Workflow terminal states for which a fresh run is a meaningful recovery. */
export function isRetryableWorkflowRunStatus(
  status: WorkflowRunStatus,
): boolean {
  return status === "failed" || status === "cancelled";
}

/** Stable label for the recovery action. */
export function workflowRunRecoveryLabel(
  status: WorkflowRunStatus,
): string | null {
  return isRetryableWorkflowRunStatus(status) ? "Run again" : null;
}
