import type { TaskArtifact, TaskRunHead } from "./taskRunContracts";

export type TaskExecutionStateKey =
  | "untracked"
  | "waiting"
  | "executing"
  | "recovery-pending"
  | "ready-to-resume"
  | "delivered"
  | "failed"
  | "stopped";

export type TaskExecutionState = {
  key: TaskExecutionStateKey;
  label: string;
  tone: "neutral" | "active" | "warning" | "success" | "danger";
};

/** A thread is task-associated only when it declares exactly one valid tag. */
export function extractCanonicalTaskId(
  tags: readonly string[][],
): string | null {
  const taskTags = tags.filter((tag) => tag[0] === "task");
  if (taskTags.length !== 1 || taskTags[0]?.length !== 2) return null;
  return taskTags[0][1]?.trim() || null;
}

/** Convert durable state and accepted lease expiry into founder-facing truth. */
export function deriveTaskExecutionState(
  run:
    | Pick<TaskRunHead, "runStatus" | "leaseExpiresAt">
    | { runStatus: TaskRunHead["runStatus"]; leaseExpiresAt?: number | null }
    | null,
  nowSeconds: number,
): TaskExecutionState {
  if (!run)
    return { key: "untracked", label: "No execution record", tone: "neutral" };
  switch (run.runStatus) {
    case "queued":
      return { key: "waiting", label: "Waiting for an agent", tone: "neutral" };
    case "executing":
      return run.leaseExpiresAt !== null &&
        run.leaseExpiresAt !== undefined &&
        run.leaseExpiresAt <= nowSeconds
        ? {
            key: "recovery-pending",
            label: "Recovery pending",
            tone: "warning",
          }
        : { key: "executing", label: "In progress", tone: "active" };
    case "recoverable":
      return {
        key: "ready-to-resume",
        label: "Ready to resume",
        tone: "warning",
      };
    case "delivered":
      return { key: "delivered", label: "Delivered", tone: "success" };
    case "failed":
      return { key: "failed", label: "Failed", tone: "danger" };
    case "abandoned":
      return { key: "stopped", label: "Stopped", tone: "danger" };
  }
}

/** Evidence is deliverable UI only after the relay accepted a delivered head. */
export function splitDeliveryArtifacts(
  run: Pick<TaskRunHead, "runStatus" | "artifacts"> | null,
): { primary: TaskArtifact | null; supporting: TaskArtifact[] } {
  if (run?.runStatus !== "delivered" || run.artifacts.length === 0) {
    return { primary: null, supporting: [] };
  }
  return {
    primary: run.artifacts[0] ?? null,
    supporting: run.artifacts.slice(1),
  };
}
