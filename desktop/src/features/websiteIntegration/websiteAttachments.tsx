/**
 * Channel-root and right-thread attachment for a verified Website Manager job.
 *
 * Placement is by event id, not by composite rendering: the channel root
 * message whose id equals the head `thread` tag gets the substantial
 * brief/working/review projection. The thread card body is shared with the
 * delegated `website-job` Block composite (`WebsiteThreadBody`); when that
 * composite is rendering the same instance, this attachment stays hidden so
 * the owner never sees two sets of decision controls.
 */

import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { useAgentRoleTitles } from "@/features/agents/useKnownAgentPubkeys";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { WebsiteBrief } from "@/features/website/WebsiteBrief";
import { WebsiteJobCard } from "@/features/website/JobCard";
import { WebsiteReview } from "@/features/website/WebsiteReview";
import { WebsiteWorking } from "@/features/website/WebsiteWorking";
import type {
  WebsiteBriefView,
  WebsitePreviewHostAdapter,
  WebsiteStartRequest,
} from "@/features/website/types";

import { useAttachmentClipBounds } from "./clipBounds";
import {
  briefViewFromInstanceData,
  useWebsiteInstanceData,
} from "./websiteInstanceData";
import {
  createWebsiteArtifactLoaderAdapter,
  createWebsiteHostAdapter,
} from "./nativePreviewAdapter";
import {
  isWebsiteCompositeRendered,
  subscribeWebsiteCompositeRegistry,
} from "./websiteCompositeRegistry";
import { useWebsiteHeads } from "./useWebsiteHeads";
import { buildWebsiteAgentDirectory } from "./websiteAgentDirectory";
import { WebsiteAttachmentBoundary } from "./WebsiteAttachmentBoundary";
import {
  deriveWebsiteProgress,
  deriveWebsiteStageAgents,
} from "./websiteProgress";
import type { WebsiteHead } from "./websiteHeads";
import { submitWebsiteBeginWork } from "./websiteTransport";
import { WebsiteThreadBody } from "./WebsiteThreadBody";

function useWebsiteAttachmentContext(input: {
  channelId: string | null;
  layoutVariant: "default" | "thread-reply";
  message: TimelineMessage;
}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? null;
  const relaySelf = useRelaySelfQuery(Boolean(communityId)).data ?? null;
  const heads = useWebsiteHeads({
    communityId,
    channelId: input.channelId,
    relaySelfPubkey: relaySelf ? relaySelf.toLowerCase() : null,
  });
  const surface = input.layoutVariant === "thread-reply" ? "thread" : "channel";
  const head = React.useMemo(() => {
    if (!input.channelId) return null;
    const target = input.message.id.toLowerCase();
    return (
      heads.find((candidate) =>
        surface === "channel"
          ? candidate.threadRoot === target
          : candidate.instanceEventId === target,
      ) ?? null
    );
  }, [heads, input.channelId, input.message.id, surface]);
  return { communityId, head, surface };
}

function WebsiteRootAttachment({
  communityId,
  head,
  profiles,
}: {
  communityId: string;
  head: WebsiteHead;
  profiles: UserProfileLookup | undefined;
}) {
  const record = head.record;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const getClipBounds = useAttachmentClipBounds(rootRef);
  const progress = React.useMemo(() => deriveWebsiteProgress(record), [record]);
  const stageAgents = React.useMemo(
    () => deriveWebsiteStageAgents(head),
    [head],
  );
  const roleTitles = useAgentRoleTitles();
  const agents = React.useMemo(
    () => buildWebsiteAgentDirectory({ profiles, head, roleTitles }),
    [head, profiles, roleTitles],
  );
  const instanceState = useWebsiteInstanceData({
    communityId,
    channelId: head.channelId,
    head,
  });
  const brief: WebsiteBriefView | undefined =
    instanceState.status === "ready"
      ? briefViewFromInstanceData(instanceState.data)
      : undefined;
  const hostAdapter = React.useMemo<WebsitePreviewHostAdapter | undefined>(
    () => createWebsiteHostAdapter() ?? undefined,
    [],
  );
  const artifactLoader = React.useMemo(
    () => createWebsiteArtifactLoaderAdapter(communityId),
    [communityId],
  );
  const onStart = React.useCallback(
    (request: WebsiteStartRequest): void => {
      if (
        request.jobId !== head.jobId ||
        request.taskId !== head.taskId ||
        request.channel !== head.channelId
      ) {
        return;
      }
      void submitWebsiteBeginWork(communityId, head);
    },
    [communityId, head],
  );
  const isReviewState =
    record.status === "readyForReview" ||
    record.status === "approved" ||
    record.status === "handedOver";

  return (
    <div className="mt-2" data-testid="website-root-attachment" ref={rootRef}>
      <WebsiteJobCard agents={agents} brief={brief} record={record}>
        {record.status === "draft" ? (
          <WebsiteBrief brief={brief} onStart={onStart} record={record} />
        ) : null}
        {record.status === "working" || record.status === "changesRequested" ? (
          <WebsiteWorking
            agents={agents}
            progress={progress}
            record={record}
            stageAgents={stageAgents}
          />
        ) : null}
        {isReviewState ? (
          <WebsiteReview
            actor=""
            agents={agents}
            artifactLoader={artifactLoader}
            communityId={communityId}
            getClipBounds={getClipBounds}
            hostAdapter={hostAdapter}
            record={record}
            showDecisionControls={false}
            showQaPanel={false}
            showVersionHistory={false}
          />
        ) : null}
      </WebsiteJobCard>
    </div>
  );
}

type WebsiteMessageAttachmentProps = {
  channelId?: string | null;
  /**
   * Accepted for the message-row call site; the shared body resolves the
   * viewer identity itself so both placement paths use one actor source.
   */
  currentPubkey?: string;
  layoutVariant?: "default" | "thread-reply";
  message: TimelineMessage;
  profiles?: UserProfileLookup;
};

/**
 * One small insertion point for the message row and thread panel. It renders
 * nothing unless this exact event id maps to a verified head on the surface it
 * belongs to. The boundary keeps a projection defect from taking down the
 * whole timeline.
 */
export function WebsiteMessageAttachment(props: WebsiteMessageAttachmentProps) {
  return (
    <WebsiteAttachmentBoundary>
      <WebsiteAttachmentInner {...props} />
    </WebsiteAttachmentBoundary>
  );
}

function WebsiteAttachmentInner({
  channelId,
  currentPubkey,
  layoutVariant = "default",
  message,
  profiles,
}: WebsiteMessageAttachmentProps) {
  const { communityId, head, surface } = useWebsiteAttachmentContext({
    channelId: channelId ?? null,
    layoutVariant,
    message,
  });
  const compositeRendered = React.useSyncExternalStore(
    subscribeWebsiteCompositeRegistry,
    () => isWebsiteCompositeRendered(message.id),
    () => false,
  );
  if (!communityId || !head) return null;
  if (surface === "channel") {
    return (
      <WebsiteRootAttachment
        communityId={communityId}
        head={head}
        profiles={profiles}
      />
    );
  }
  if (compositeRendered) return null;
  return (
    <WebsiteThreadBody
      actorPubkey={currentPubkey}
      communityId={communityId}
      head={head}
      message={message}
      profiles={profiles}
      testId="website-thread-attachment"
    />
  );
}
