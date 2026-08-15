/** Key for the bounded durable-task run projection. */
export function actionCenterTaskRunsQueryKey(
  communityId: string,
  taskIds: readonly string[],
) {
  return ["action-center-task-runs", communityId, taskIds] as const;
}

/** Key for the community-scoped workflow list projection. */
export function actionCenterWorkflowQueryKey(
  communityId: string,
  channelIdKey: string,
) {
  return ["action-center-workflows", communityId, channelIdKey] as const;
}

/** Key for one community-scoped workflow run list. */
export function actionCenterWorkflowRunsQueryKey(
  communityId: string,
  workflowId: string,
) {
  return ["action-center-workflow-runs", communityId, workflowId] as const;
}

/** Key for one community-scoped workflow approval list. */
export function actionCenterApprovalsQueryKey(
  communityId: string,
  workflowId: string,
  runId: string,
) {
  return [
    "action-center-workflow-approvals",
    communityId,
    workflowId,
    runId,
  ] as const;
}
