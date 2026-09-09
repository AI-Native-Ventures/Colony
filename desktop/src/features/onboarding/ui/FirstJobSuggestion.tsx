import { type ReactNode, useId } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCommunities } from "@/features/communities/useCommunities";
import { useTask } from "@/features/company/hooks";
import type { TaskStatus } from "@/features/company/contracts";
import { statusPillTone } from "@/features/company/workListModel";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  canStartFirstJobSuggestion,
  parseFirstJobSuggestion,
  type FirstJobSuggestion as SuggestionPayload,
} from "../firstJobSuggestion";
import { firstJobScopeKey, type FirstJobScope } from "../firstJobStart";
import {
  firstJobWorkerRole,
  previewFirstJobTeam,
} from "../firstJobTeamPreparation";
import { useFirstJobSuggestion } from "../useFirstJobSuggestion";
import { useFirstJobTaskUpdates } from "../useFirstJobTaskUpdates";
import { useFirstJobDiscovery } from "../useFirstJobDiscovery";
import {
  FirstJobSuggestionView,
  type FirstJobTaskState,
} from "./FirstJobSuggestionView";

const TASK_LABELS: Record<TaskStatus, string> = {
  proposed: "Task proposed",
  ready: "Ready",
  inProgress: "In progress",
  inReview: "Ready for review",
  blocked: "Blocked",
  snoozed: "Snoozed",
  completed: "Completed",
  cancelled: "Cancelled",
};

function ReadySuggestion({
  scope,
  payload,
  communityId,
}: {
  scope: FirstJobScope;
  payload: SuggestionPayload;
  communityId: string;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, snapshot } = useFirstJobSuggestion(scope, payload);
  const workerRole = firstJobWorkerRole(payload.businessName, snapshot.brief);
  const teamQuery = useQuery({
    queryKey: [
      "firstJobTeamPreview",
      firstJobScopeKey(scope),
      workerRole.roleId,
    ],
    queryFn: () =>
      previewFirstJobTeam(scope, payload.businessName, snapshot.brief),
    enabled: snapshot.phase !== "sent",
    staleTime: 15_000,
    retry: false,
  });
  const discoveryAvailable = useFirstJobDiscovery(
    scope,
    communityId,
    !snapshot.briefLocked,
  );
  const taskQuery = useTask(
    communityId,
    snapshot.taskId,
    snapshot.phase === "sent",
  );
  useFirstJobTaskUpdates(
    scope,
    communityId,
    snapshot.taskId,
    snapshot.phase === "sent",
  );
  const task = taskQuery.data?.ok ? taskQuery.data.value : null;
  const taskState =
    task &&
    task.threadRoot === scope.threadRootId &&
    task.sourceChannelId === scope.channelId
      ? {
          label: TASK_LABELS[task.status],
          tone: statusPillTone(task.status) as FirstJobTaskState["tone"],
        }
      : null;
  const explore = () => {
    session.explore();
    void navigate({
      to: "/channels/$channelId",
      params: { channelId: scope.channelId },
      search: {},
    });
  };
  return (
    <FirstJobSuggestionView
      idPrefix={`first-job-${id}`}
      businessName={payload.businessName}
      businessSummary={payload.business}
      discoveryAvailable={discoveryAvailable}
      brief={snapshot.brief}
      briefLocked={snapshot.briefLocked}
      phase={snapshot.phase}
      error={
        snapshot.error ??
        (teamQuery.error instanceof Error ? teamQuery.error.message : null)
      }
      teamProposal={teamQuery.data}
      teamLoading={teamQuery.isPending}
      teamRequired
      onCheckTeam={() => {
        void teamQuery.refetch();
      }}
      onReviewBusiness={
        snapshot.businessRepair
          ? () => {
              void navigate({
                to: "/settings",
                search: { section: "company" },
              });
            }
          : undefined
      }
      canManage
      taskState={taskState}
      onBriefChange={session.edit}
      onStart={() => {
        void session.start(teamQuery.data);
      }}
      onRetry={() => {
        void session.start(teamQuery.data);
      }}
      onAddCredits={() => {
        void session.showFunding();
      }}
      onExplore={explore}
      onReviewTeam={() => {
        void navigate({ to: "/agents" });
      }}
      funding={
        snapshot.funding
          ? {
              ...snapshot.funding,
              onSelectPack: session.selectPack,
              onReceiptEmailChange: session.editEmail,
              onPay: () => {
                void session.pay();
              },
              onCheck: () => {
                void session.checkCredits().then(() => {
                  void queryClient.invalidateQueries({
                    queryKey: ["colonyCreditsAccount"],
                  });
                });
              },
              onReopen: () => {
                void session.reopen();
              },
              onReloadPrices: () => {
                void session.reloadPrices();
              },
              onExplore: explore,
            }
          : null
      }
    />
  );
}

/** Only the accepted owner-signed root in the active account/community exposes Start. */
export default function FirstJobSuggestion({
  message,
  channelId,
  currentPubkey,
  children,
}: {
  message: TimelineMessage;
  channelId: string | null;
  currentPubkey?: string;
  children: ReactNode;
}) {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery().data;
  const payload = parseFirstJobSuggestion(message.tags);
  const eligible =
    payload &&
    channelId &&
    activeCommunity &&
    identity?.pubkey &&
    identity.pubkey === currentPubkey &&
    !identity.locked &&
    !identity.lost &&
    !identity.resetFailed &&
    canStartFirstJobSuggestion(message, {
      ownerPubkey: identity.pubkey,
      relayUrl: activeCommunity.relayUrl,
      channelId,
    });
  if (!eligible || !payload || !channelId || !activeCommunity) return children;
  const scope: FirstJobScope = {
    ownerPubkey: payload.ownerPubkey,
    relayUrl: payload.relayUrl,
    channelId,
    threadRootId: message.id,
    requestId: payload.requestId,
  };
  return (
    <ReadySuggestion
      key={JSON.stringify(scope)}
      scope={scope}
      payload={payload}
      communityId={activeCommunity.id}
    />
  );
}
