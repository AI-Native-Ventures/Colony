import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { useReportingLineLookup } from "@/features/agents/reportingLine";
import {
  askRoutingSummary,
  classifyAskRouting,
  effectiveFilerPubkey,
} from "@/features/asks/lib/askRouting";
import { useOpenAsks } from "@/features/asks/useOpenAsks";
import { useResolvedAsks } from "@/features/asks/useAskResolutions";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useHomeFeedQuery } from "@/features/home/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import { useRemindersQuery } from "@/features/reminders/hooks";
import { relayClient } from "@/shared/api/relayClient";
import {
  getChannelsWorkflows,
  getRunApprovals,
  getWorkflowRuns,
} from "@/shared/api/tauriWorkflows";
import { useIdentityQuery } from "@/shared/api/hooks";
import { KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";
import { useFeatureEnabled } from "@/shared/features";
import { normalizePubkey, truncatePubkey } from "@/shared/lib/pubkey";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import type {
  HomeFeedResponse,
  Workflow,
  WorkflowApproval,
  WorkflowRun,
} from "@/shared/api/types";

import {
  buildActionCenterItems,
  countActionableItems,
  filterActionCenterItems,
} from "./actionCenterModel";
import {
  actionCenterApprovalsQueryKey,
  actionCenterCompanyProfileQueryKey,
  actionCenterWorkflowQueryKey,
  actionCenterWorkflowRunsQueryKey,
} from "./lib/actionCenterQueryKeys";
import { readCompanyAskWindowSecs } from "./lib/companyAskWindow";
import { selectOwnerWorkflowApprovalSources } from "./lib/workflowApprovals";
import type {
  ActionCenterFilter,
  ActionCenterStateFilter,
  ActionItem,
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
  const ownerPubkey = identityQuery.data?.pubkey ?? null;
  const { activeCommunity } = useCommunities();
  const workflowsEnabled = useFeatureEnabled("workflows");
  const communityId = activeCommunity?.id ?? "";
  const homeFeedQuery = useHomeFeedQuery();
  const openAsks = useOpenAsks();
  const resolvedAsksResult = useResolvedAsks();
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

  // The only way to discover a pending approval is to walk each workflow's
  // latest run and, when it is waiting on one, fetch that run's approvals —
  // there is no bulk "pending approvals for this owner" endpoint. This fan-out
  // is therefore kept; what changed is the output: `selectOwnerWorkflowApprovalSources`
  // below narrows it to runs whose approval names this owner specifically,
  // instead of surfacing every run state as a queue item.
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
  const pendingApprovals = React.useMemo(
    () =>
      workflowApprovalQueries.map((query) => {
        const approvals = (query.data as WorkflowApproval[] | undefined) ?? [];
        return (
          approvals.find((candidate) => candidate.status === "pending") ?? null
        );
      }),
    [workflowApprovalQueries],
  );
  const workflowSources = React.useMemo(
    () =>
      selectOwnerWorkflowApprovalSources({
        latestRuns,
        ownerPubkey,
        pendingApprovals,
        workflows,
        workflowsEnabled,
      }),
    [latestRuns, ownerPubkey, pendingApprovals, workflows, workflowsEnabled],
  );

  // The community's ask-window override feeds every ask's ranking deadline
  // (tier 1). A missing/unreachable value never blocks the queue -- it just
  // falls back to `DEFAULT_ASK_WINDOW_SECS` inside `computeAskDeadline`,
  // mirroring the broker's own "never fails" company-default read -- so
  // this query's own errors are deliberately not surfaced or awaited.
  const relaySelfQuery = useRelaySelfQuery();
  const relayPubkey = relaySelfQuery.data ?? null;
  const companyProfileQuery = useQuery({
    queryKey: actionCenterCompanyProfileQueryKey(
      communityId,
      relayPubkey ?? "",
    ),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_COMPANY_PROFILE],
        authors: [relayPubkey ?? ""],
        limit: 1,
      }),
    enabled: communityId !== "" && relayPubkey !== null,
    staleTime: 5 * 60_000,
  });
  const companyAskWindowSecs = React.useMemo(
    () => readCompanyAskWindowSecs(companyProfileQuery.data ?? [], relayPubkey),
    [companyProfileQuery.data, relayPubkey],
  );

  const feed = homeFeedQuery.data?.feed;
  const reminders = remindersQuery.data ?? [];
  const { lookup: reportingLineLookup } = useReportingLineLookup(communityId);
  const resolvedAsks = resolvedAsksResult.resolvedAsks;
  const humanResolverPubkeys = React.useMemo(
    () =>
      [
        ...new Set(
          resolvedAsks
            .filter((entry) => !entry.resolution.defaultExecuted)
            .map((entry) => entry.resolution.resolverPubkey),
        ),
      ].sort(),
    [resolvedAsks],
  );
  const resolverLabelsQuery = useUsersBatchQuery(humanResolverPubkeys, {
    enabled: humanResolverPubkeys.length > 0,
  });
  const resolverLabelsByPubkey = React.useMemo(() => {
    const labels = new Map<string, string>();
    const profiles = resolverLabelsQuery.data?.profiles;
    if (!profiles) return labels;
    for (const pubkey of humanResolverPubkeys) {
      const profile = profiles[normalizePubkey(pubkey)];
      labels.set(
        pubkey,
        profile?.displayName?.trim() || truncatePubkey(normalizePubkey(pubkey)),
      );
    }
    return labels;
  }, [humanResolverPubkeys, resolverLabelsQuery.data]);
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
        resolvedAsks,
        resolverLabelsByPubkey,
        askRoutingNotesByAskId,
        doneIds: localDoneIds,
        feed: feed ? { needsAction: feed.needsAction } : undefined,
        reminders,
        workflows: workflowSources,
        companyAskWindowSecs,
      }),
    [
      askRoutingNotesByAskId,
      companyAskWindowSecs,
      feed,
      localDoneIds,
      openAsks.asks,
      reminders,
      resolvedAsks,
      resolverLabelsByPubkey,
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
  const refetchWorkflows = workflowsQuery.refetch;
  const refetchCompanyProfile = companyProfileQuery.refetch;
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
      refetchWorkflows(),
      refetchCompanyProfile(),
      ...refetchWorkflowRuns.map((refetchOne) => refetchOne()),
      ...refetchWorkflowApprovals.map((refetchOne) => refetchOne()),
    ]);
  }, [
    refetchAsks,
    refetchCompanyProfile,
    refetchHomeFeed,
    refetchReminders,
    refetchWorkflowApprovals,
    refetchWorkflowRuns,
    refetchWorkflows,
  ]);

  const queryErrors = [
    homeFeedQuery.error,
    openAsks.error,
    remindersQuery.error,
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
