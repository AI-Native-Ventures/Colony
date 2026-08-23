import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { useReportingLineLookup } from "@/features/agents/reportingLine";
import {
  askRoutingSummary,
  classifyAskRouting,
  effectiveFilerPubkey,
} from "@/features/asks/lib/askRouting";
import { useOpenAsks } from "@/features/asks/useOpenAsks";
import { useActiveCompany, useCompanyTasks } from "@/features/company/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useHomeFeedQuery } from "@/features/home/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useRemindersQuery } from "@/features/reminders/hooks";
import {
  getChannelsWorkflows,
  getRunApprovals,
  getWorkflowRuns,
} from "@/shared/api/tauriWorkflows";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useFeatureEnabled } from "@/shared/features";
import { relayClient } from "@/shared/api/relayClient";
import type {
  HomeFeedResponse,
  Workflow,
  WorkflowApproval,
  WorkflowRun,
} from "@/shared/api/types";
import { KIND_JOB_HEAD } from "@/shared/constants/kinds";

import {
  buildActionCenterItems,
  countActionableItems,
  filterActionCenterItems,
} from "./actionCenterModel";
import {
  actionCenterApprovalsQueryKey,
  actionCenterTaskRunsQueryKey,
  actionCenterWorkflowQueryKey,
  actionCenterWorkflowRunsQueryKey,
} from "./lib/actionCenterQueryKeys";
import { buildTaskSources } from "./lib/taskActionCenter";
import type {
  ActionCenterFilter,
  ActionCenterStateFilter,
  ActionItem,
  ActionWorkflowSource,
} from "./contracts";

export type ActionCenterItemsOptions = {
  filter?: ActionCenterFilter;
  localDoneIds?: ReadonlySet<string>;
  state?: ActionCenterStateFilter;
};

function firstError(errors: readonly unknown[]): Error | null {
  return errors.find((cause): cause is Error => cause instanceof Error) ?? null;
}

function latestWorkflowRun(runs: readonly WorkflowRun[]): WorkflowRun | null {
  return (
    [...runs].sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.id.localeCompare(right.id),
    )[0] ?? null
  );
}

export function useActionCenterItems({
  filter = "needs-action",
  localDoneIds = new Set<string>(),
  state,
}: ActionCenterItemsOptions = {}) {
  const identityQuery = useIdentityQuery();
  const { activeCommunity } = useCommunities();
  const workflowsEnabled = useFeatureEnabled("workflows");
  const communityId = activeCommunity?.id ?? "";
  const homeFeedQuery = useHomeFeedQuery();
  const openAsks = useOpenAsks();
  const remindersQuery = useRemindersQuery(identityQuery.data?.pubkey);
  const channelsQuery = useChannelsQuery();
  const memberChannelIds = React.useMemo(
    () =>
      (channelsQuery.data ?? [])
        .filter((channel) => channel.isMember)
        .map((channel) => channel.id)
        .sort(),
    [channelsQuery.data],
  );
  const channelIdKey = memberChannelIds.join(",");

  const activeCompanyQuery = useActiveCompany(communityId);
  const activeCompanyId = activeCompanyQuery.data?.ok
    ? activeCompanyQuery.data.value.id
    : null;
  const tasksQuery = useCompanyTasks(
    communityId,
    { companyId: activeCompanyId ?? undefined },
    activeCompanyId !== null,
  );
  const tasks = tasksQuery.data?.ok ? tasksQuery.data.value : [];
  const taskIds = React.useMemo(
    () => tasks.map((task) => task.id).sort(),
    [tasks],
  );
  const taskRunsQuery = useQuery({
    queryKey: actionCenterTaskRunsQueryKey(communityId, taskIds),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_JOB_HEAD],
        "#task": taskIds,
        limit: 500,
      }),
    enabled: communityId !== "" && taskIds.length > 0,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
  const taskSources = React.useMemo(
    () => buildTaskSources(tasks, taskRunsQuery.data ?? []),
    [tasks, taskRunsQuery.data],
  );

  const workflowsQuery = useQuery<Workflow[]>({
    queryKey: actionCenterWorkflowQueryKey(communityId, channelIdKey),
    queryFn: () => getChannelsWorkflows(memberChannelIds),
    enabled:
      workflowsEnabled && communityId !== "" && memberChannelIds.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const workflows = workflowsQuery.data ?? [];
  const workflowRunQueries = useQueries({
    queries: workflows.map((workflow) => ({
      queryKey: actionCenterWorkflowRunsQueryKey(communityId, workflow.id),
      queryFn: () => getWorkflowRuns(workflow.id, 20),
      staleTime: 10_000,
      refetchInterval: 10_000,
    })),
  });
  const latestRuns = React.useMemo(
    () =>
      workflowRunQueries.map((query) =>
        latestWorkflowRun((query.data as WorkflowRun[] | undefined) ?? []),
      ),
    [workflowRunQueries],
  );
  const workflowApprovalQueries = useQueries({
    queries: workflows.map((workflow, index) => {
      const run = latestRuns[index] ?? null;
      return {
        queryKey: actionCenterApprovalsQueryKey(
          communityId,
          workflow.id,
          run?.id ?? "",
        ),
        queryFn: () => getRunApprovals(workflow.id, run?.id ?? ""),
        enabled: run?.status === "waiting_approval",
        staleTime: 5_000,
        refetchInterval: 10_000,
      };
    }),
  });
  const workflowSources = React.useMemo<ActionWorkflowSource[]>(
    () =>
      workflows.flatMap((workflow, index) => {
        const run = latestRuns[index];
        if (!run) return [];
        const approvalQuery = workflowApprovalQueries[index];
        const approvals =
          (approvalQuery?.data as WorkflowApproval[] | undefined) ?? [];
        const approval =
          approvals.find((candidate) => candidate.status === "pending") ?? null;
        // A waiting run is only actionable when the backend returned a real
        // approval record. Do not manufacture an inert workflow row while the
        // approval read is loading, failed, or empty.
        if (
          run.status === "waiting_approval" &&
          (approvalQuery?.isLoading || approvalQuery?.isError || !approval)
        ) {
          return [];
        }
        return [
          {
            kind: "workflow" as const,
            workflow,
            run,
            approval,
          },
        ];
      }),
    [latestRuns, workflowApprovalQueries, workflows],
  );

  const feed = homeFeedQuery.data?.feed;
  const reminders = remindersQuery.data ?? [];
  const { lookup: reportingLineLookup } = useReportingLineLookup(communityId);
  const askRoutingNotesByAskId = React.useMemo(() => {
    const notes = new Map<string, string>();
    for (const ask of openAsks.asks) {
      const routing = classifyAskRouting(
        ask,
        reportingLineLookup(effectiveFilerPubkey(ask)).managerPubkey,
      );
      const note = askRoutingSummary(routing);
      if (note) notes.set(ask.id, note);
    }
    return notes;
  }, [openAsks.asks, reportingLineLookup]);
  const allItems = React.useMemo(
    () =>
      buildActionCenterItems({
        asks: openAsks.asks,
        askRoutingNotesByAskId,
        doneIds: localDoneIds,
        feed: feed
          ? {
              mentions: feed.mentions,
              needsAction: feed.needsAction,
              activity: feed.activity,
              agentActivity: feed.agentActivity,
            }
          : undefined,
        reminders,
        tasks: taskSources,
        workflows: workflowSources,
      }),
    [
      askRoutingNotesByAskId,
      feed,
      localDoneIds,
      openAsks.asks,
      reminders,
      taskSources,
      workflowSources,
    ],
  );
  const items = React.useMemo(
    () => filterActionCenterItems(allItems, filter, state),
    [allItems, filter, state],
  );

  const refetchHomeFeed = homeFeedQuery.refetch;
  const refetchAsks = openAsks.refetch;
  const refetchReminders = remindersQuery.refetch;
  const refetchTasks = tasksQuery.refetch;
  const refetchTaskRuns = taskRunsQuery.refetch;
  const refetchWorkflows = workflowsQuery.refetch;
  const refetchWorkflowRuns = React.useMemo(
    () => workflowRunQueries.map((query) => query.refetch),
    [workflowRunQueries],
  );
  const refetchWorkflowApprovals = React.useMemo(
    () => workflowApprovalQueries.map((query) => query.refetch),
    [workflowApprovalQueries],
  );
  const refetch = React.useCallback(async () => {
    await Promise.all([
      refetchHomeFeed(),
      refetchAsks(),
      refetchReminders(),
      refetchTasks(),
      refetchTaskRuns(),
      refetchWorkflows(),
      ...refetchWorkflowRuns.map((refetchOne) => refetchOne()),
      ...refetchWorkflowApprovals.map((refetchOne) => refetchOne()),
    ]);
  }, [
    refetchAsks,
    refetchHomeFeed,
    refetchReminders,
    refetchTaskRuns,
    refetchTasks,
    refetchWorkflowApprovals,
    refetchWorkflowRuns,
    refetchWorkflows,
  ]);

  const queryErrors = [
    homeFeedQuery.error,
    openAsks.error,
    remindersQuery.error,
    activeCompanyQuery.error,
    tasksQuery.error,
    taskRunsQuery.error,
    workflowsQuery.error,
    channelsQuery.error,
    ...workflowRunQueries.map((query) => query.error),
    ...workflowApprovalQueries.map((query) => query.error),
  ];

  const isCoreLoading =
    identityQuery.isLoading ||
    homeFeedQuery.isLoading ||
    openAsks.isLoading ||
    remindersQuery.isLoading;
  const isOptionalSourceLoading =
    channelsQuery.isLoading ||
    activeCompanyQuery.isLoading ||
    tasksQuery.isLoading ||
    taskRunsQuery.isLoading ||
    workflowsQuery.isLoading ||
    workflowRunQueries.some((query) => query.isLoading) ||
    workflowApprovalQueries.some((query) => query.isLoading);

  return {
    allItems,
    error: firstError(queryErrors),
    isLoading: isCoreLoading,
    isSettled: !isCoreLoading && !isOptionalSourceLoading,
    items,
    openCount: countActionableItems(allItems),
    refetch,
    workflowsEnabled,
  } satisfies {
    allItems: ActionItem[];
    error: Error | null;
    isLoading: boolean;
    isSettled: boolean;
    items: ActionItem[];
    openCount: number;
    refetch: () => Promise<void>;
    workflowsEnabled: boolean;
  };
}

export function feedForActionCenter(
  response: HomeFeedResponse | undefined,
): HomeFeedResponse["feed"] | undefined {
  return response?.feed;
}
