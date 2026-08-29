import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { useReportingLineLookup } from "@/features/agents/reportingLine";
import { readAsk } from "@/features/asks/lib/askEvent";
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
import { KIND_ASK, KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";
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
  askContextSubjectPubkey,
  type PriorAskProvenance,
} from "./lib/askContextLine";
import {
  actionCenterApprovalsQueryKey,
  actionCenterCompanyProfileQueryKey,
  actionCenterPriorAsksQueryKey,
  actionCenterWorkflowQueryKey,
  actionCenterWorkflowRunsQueryKey,
} from "./lib/actionCenterQueryKeys";
import { readCompanyAskWindowSecs } from "./lib/companyAskWindow";
import { selectOwnerWorkflowApprovalSources } from "./lib/workflowApprovals";
import { useThreadPings } from "./useThreadPings";
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
  const mentions = React.useMemo(() => feed?.mentions ?? [], [feed]);
  // Reuses this hook's own homeFeedQuery/identityQuery/relaySelfQuery rather
  // than letting useThreadPings mount its own copies -- a second observer on
  // the same query key polls on its own schedule (see
  // ActionCenterContext.tsx's doc comment on why this hook exists at all).
  const threadPings = useThreadPings({
    mentions,
    ownerPubkey,
    relaySelfPubkey: relayPubkey,
  });
  const reminders = remindersQuery.data ?? [];
  const { lookup: reportingLineLookup } = useReportingLineLookup(communityId);
  const resolvedAsks = resolvedAsksResult.resolvedAsks;

  // Escalation provenance (spec, resolved question 5): one batched `ids`
  // fetch for every distinct `priorAskId` the current open asks name, never
  // one fetch per row. `priorAskId`s are immutable once minted (a prior ask
  // never changes after being superseded), so this can cache aggressively.
  const priorAskIds = React.useMemo(
    () =>
      [
        ...new Set(
          openAsks.asks
            .map((ask) => ask.priorAskId)
            .filter((id): id is string => id !== null),
        ),
      ].sort(),
    [openAsks.asks],
  );
  const priorAsksQuery = useQuery({
    queryKey: actionCenterPriorAsksQueryKey(communityId, priorAskIds.join(",")),
    queryFn: () =>
      relayClient.fetchEvents({
        ids: priorAskIds,
        kinds: [KIND_ASK],
        limit: priorAskIds.length,
      }),
    enabled: priorAskIds.length > 0,
    staleTime: 5 * 60_000,
  });
  const priorAsksById = React.useMemo(() => {
    const byId = new Map<string, PriorAskProvenance>();
    for (const event of priorAsksQuery.data ?? []) {
      const parsed = readAsk(event);
      if (parsed) {
        byId.set(parsed.id, {
          audiencePubkey: parsed.audiencePubkey,
          createdAt: parsed.createdAt,
        });
      }
    }
    return byId;
  }, [priorAsksQuery.data]);

  // One combined pubkey-to-display-name batch, shared by resolved-ask
  // summaries, ask context lines ("Ask from <name>"), and escalation lines
  // ("sat with <name>") -- a second useUsersBatchQuery call here would be a
  // second network round trip for data the first one already covers.
  const labelPubkeys = React.useMemo(() => {
    const pubkeys = new Set<string>();
    for (const entry of resolvedAsks) {
      if (!entry.resolution.defaultExecuted) {
        pubkeys.add(entry.resolution.resolverPubkey);
      }
    }
    for (const ask of openAsks.asks) {
      pubkeys.add(askContextSubjectPubkey(ask));
    }
    for (const prior of priorAsksById.values()) {
      if (prior.audiencePubkey) pubkeys.add(prior.audiencePubkey);
    }
    return [...pubkeys].sort();
  }, [openAsks.asks, priorAsksById, resolvedAsks]);
  const labelsQuery = useUsersBatchQuery(labelPubkeys, {
    enabled: labelPubkeys.length > 0,
  });
  const labelsByPubkey = React.useMemo(() => {
    const labels = new Map<string, string>();
    const profiles = labelsQuery.data?.profiles;
    if (!profiles) return labels;
    for (const pubkey of labelPubkeys) {
      const profile = profiles[normalizePubkey(pubkey)];
      labels.set(
        pubkey,
        profile?.displayName?.trim() || truncatePubkey(normalizePubkey(pubkey)),
      );
    }
    return labels;
  }, [labelPubkeys, labelsQuery.data]);
  const askRoutingNotesByAskId = React.useMemo(() => {
    const notes = new Map<string, string>();
    for (const ask of openAsks.asks) {
      const routing = classifyAskRouting(
        ask,
        reportingLineLookup(effectiveFilerPubkey(ask)).managerPubkey,
      );
      // A promoted ask's escalation line already says this, with more detail
      // (audience name and duration) -- suppressing the generic note here
      // avoids repeating the same fact twice on one row.
      if (routing?.kind === "promoted") continue;
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
        resolverLabelsByPubkey: labelsByPubkey,
        askRoutingNotesByAskId,
        contextLabelsByPubkey: labelsByPubkey,
        priorAsksById,
        doneIds: localDoneIds,
        feed: feed ? { needsAction: feed.needsAction } : undefined,
        reminders,
        workflows: workflowSources,
        pings: threadPings.pings,
        companyAskWindowSecs,
      }),
    [
      askRoutingNotesByAskId,
      companyAskWindowSecs,
      feed,
      labelsByPubkey,
      localDoneIds,
      openAsks.asks,
      priorAsksById,
      reminders,
      resolvedAsks,
      threadPings.pings,
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
  const refetchThreadPings = threadPings.refetch;
  const refetchPriorAsks = priorAsksQuery.refetch;
  const refetch = React.useCallback(async () => {
    await Promise.all([
      refetchHomeFeed(),
      refetchAsks(),
      refetchReminders(),
      refetchWorkflows(),
      refetchCompanyProfile(),
      refetchThreadPings(),
      refetchPriorAsks(),
      ...refetchWorkflowRuns.map((refetchOne) => refetchOne()),
      ...refetchWorkflowApprovals.map((refetchOne) => refetchOne()),
    ]);
  }, [
    refetchAsks,
    refetchCompanyProfile,
    refetchHomeFeed,
    refetchPriorAsks,
    refetchReminders,
    refetchThreadPings,
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
    workflowApprovalQueries.some((query) => query.isLoading) ||
    threadPings.isLoading;

  return {
    allItems,
    dismissPing: threadPings.dismiss,
    error: firstError(queryErrors),
    isLoading: isCoreLoading,
    isSettled: !isCoreLoading && !isOptionalSourceLoading,
    items,
    openCount: countActionableItems(allItems),
    refetch,
    workflowsEnabled,
  } satisfies {
    allItems: ActionItem[];
    dismissPing: (pingId: string) => Promise<void>;
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
