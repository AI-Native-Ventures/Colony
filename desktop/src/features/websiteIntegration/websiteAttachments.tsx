/**
 * Channel-root and right-thread attachment for a verified Website Manager job.
 *
 * Placement is by event id, not by composite rendering: the channel root
 * message whose id equals the head `thread` tag gets the substantial
 * brief/working/review projection, and the coordinator's review card whose
 * event id equals the head `instance` tag gets the review details and owner
 * controls inside the right thread. Both read the same verified head store and
 * share the feature preview arbiter, so only one surface owns the interactive
 * native view.
 */

import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type {
  WebsiteAgentDirectory,
  WebsiteAgentIdentity,
  WebsiteArtifactDownloadAdapter,
  WebsiteBriefView,
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
  WebsitePreviewHostAdapter,
  WebsiteReviewRecord,
} from "@/features/website/types";
import { WebsiteBrief } from "@/features/website/WebsiteBrief";
import { WebsiteDecisionPanel } from "@/features/website/WebsiteDecisionPanel";
import { WebsiteHandover } from "@/features/website/WebsiteHandover";
import { WebsiteJobCard } from "@/features/website/JobCard";
import { WebsitePreview } from "@/features/website/WebsitePreview";
import { WebsiteQaPanel } from "@/features/website/WebsiteQaPanel";
import { WebsiteReview } from "@/features/website/WebsiteReview";
import { WebsiteRevision } from "@/features/website/WebsiteRevision";
import { WebsiteVersionHistory } from "@/features/website/WebsiteVersionHistory";
import { WebsiteWorking } from "@/features/website/WebsiteWorking";
import { useQaReport } from "@/features/website/useQaReport";
import { resolveQaView } from "@/features/website/viewLogic";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";

import {
  createWebsiteArtifactLoaderAdapter,
  createWebsiteDownloadAdapter,
  createWebsiteHostAdapter,
} from "./nativePreviewAdapter";
import { useAttachmentClipBounds } from "./clipBounds";
import { useWebsiteHeads } from "./useWebsiteHeads";
import {
  briefViewFromInstanceData,
  useWebsiteInstanceData,
} from "./websiteInstanceData";
import {
  deriveWebsiteProgress,
  deriveWebsiteStageAgents,
} from "./websiteProgress";
import {
  submitWebsiteBeginWork,
  submitWebsiteDecision,
  websiteInstanceRefFromMessage,
  type WebsiteInstanceRef,
} from "./websiteTransport";
import type { WebsiteHead } from "./websiteHeads";

/**
 * Stable identity colours, matching the avatar fallback hash in
 * `shared/lib/identityColour.ts` so the job surfaces agree with the rest of
 * the app about which agent is which colour.
 */
const IDENTITY_COLOUR_TOKENS = [
  "violet",
  "amber",
  "teal",
  "rose",
  "blue",
  "lime",
] as const;

export function websiteAgentColourToken(pubkey: string): string {
  let hash = 0;
  for (const character of normalizePubkey(pubkey)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return IDENTITY_COLOUR_TOKENS[hash % IDENTITY_COLOUR_TOKENS.length];
}

export function buildWebsiteAgentDirectory(input: {
  profiles: UserProfileLookup | undefined;
  record: WebsiteReviewRecord;
  head: WebsiteHead;
}): WebsiteAgentDirectory {
  const { profiles, record, head } = input;
  const directory = new Map<string, WebsiteAgentIdentity>();
  const pubkeys = new Set<string>([
    head.ownerPubkey,
    head.coordinatorPubkey,
    ...record.revisions.map((revision) => revision.builtBy),
    ...record.revisions.flatMap((revision) =>
      revision.qa ? [revision.qa.reviewer] : [],
    ),
    ...record.decisions.map((decision) => decision.actor),
    ...(record.handover ? [record.handover.acceptedBy] : []),
    ...(record.handover?.accessRequest
      ? [record.handover.accessRequest.authoredBy]
      : []),
  ]);
  for (const pubkey of pubkeys) {
    const profile =
      profiles?.[pubkey] ?? profiles?.[normalizePubkey(pubkey)];
    const name =
      profile?.displayName?.trim() || profile?.name?.trim() || undefined;
    if (!name) continue;
    directory.set(pubkey, {
      pubkey,
      name,
      role: profile?.role?.trim() || "Role not recorded",
      color: websiteAgentColourToken(pubkey),
    });
  }
  return directory;
}

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
  const progress = React.useMemo(
    () => deriveWebsiteProgress(record),
    [record],
  );
  const stageAgents = React.useMemo(
    () => deriveWebsiteStageAgents(head),
    [head],
  );
  const agents = React.useMemo(
    () => buildWebsiteAgentDirectory({ profiles, record, head }),
    [head, profiles, record],
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
    () => submitWebsiteBeginWork(communityId, head),
    [communityId, head],
  );
  const isReviewState =
    record.status === "readyForReview" ||
    record.status === "approved" ||
    record.status === "handedOver";

  return (
    <div
      className="mt-2"
      data-testid="website-root-attachment"
      ref={rootRef}
    >
      <WebsiteJobCard agents={agents} brief={brief} record={record}>
        {record.status === "draft" ? (
          <WebsiteBrief brief={brief} onStart={onStart} record={record} />
        ) : null}
        {record.status === "working" ||
        record.status === "changesRequested" ? (
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

function WebsiteThreadAttachment({
  communityId,
  head,
  message,
  profiles,
  currentPubkey,
}: {
  communityId: string;
  head: WebsiteHead;
  message: TimelineMessage;
  profiles: UserProfileLookup | undefined;
  currentPubkey: string | undefined;
}) {
  const record = head.record;
  const threadRef = React.useRef<HTMLElement | null>(null);
  const getClipBounds = useAttachmentClipBounds(threadRef);
  const agents = React.useMemo(
    () => buildWebsiteAgentDirectory({ profiles, record, head }),
    [head, profiles, record],
  );
  const artifactLoader = React.useMemo(
    () => createWebsiteArtifactLoaderAdapter(communityId),
    [communityId],
  );
  const hostAdapter = React.useMemo<WebsitePreviewHostAdapter | undefined>(
    () => createWebsiteHostAdapter() ?? undefined,
    [],
  );
  const downloadAdapter: WebsiteArtifactDownloadAdapter | undefined =
    React.useMemo(
      () => createWebsiteDownloadAdapter(communityId),
      [communityId],
    );
  const [inspection, setInspection] = React.useState<number | null>(null);
  const revision = record.revisions.find(
    (entry) => entry.revision === record.currentRevision,
  );
  const reportState = useQaReport({ loader: artifactLoader, qa: revision?.qa });
  const qaView = resolveQaView({ revision, report: reportState });
  const instance = React.useMemo<WebsiteInstanceRef | null>(
    () =>
      websiteInstanceRefFromMessage({
        head,
        messageId: message.id,
        tags: message.tags,
      }),
    [head, message.id, message.tags],
  );
  const onDecision = React.useCallback(
    (request: WebsiteDecisionRequest): Promise<WebsiteDecisionReceipt> =>
      submitWebsiteDecision({ communityId, head, request, instance }),
    [communityId, head, instance],
  );
  const selected = inspection ?? record.currentRevision;

  return (
    <section
      aria-label="Website review details"
      className={cn("mt-2 overflow-hidden rounded-xl border border-border bg-card")}
      data-testid="website-thread-attachment"
      ref={threadRef}
    >
      {inspection !== null ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3.5 py-2">
            <span className="text-2xs text-muted-foreground">
              Read-only view of Version {inspection}. Decisions apply to Version{" "}
              {record.currentRevision} only.
            </span>
            <button
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setInspection(null)}
              type="button"
            >
              Close preview
            </button>
          </div>
          <WebsitePreview
            artifactLoader={artifactLoader}
            communityId={communityId}
            getClipBounds={getClipBounds}
            hostAdapter={hostAdapter}
            onSelectRevision={setInspection}
            record={record}
            selectedRevision={inspection}
            title={`Version ${inspection} preview`}
          />
        </>
      ) : null}
      <WebsiteRevision
        agents={agents}
        onViewRevision={setInspection}
        record={record}
      />
      {record.status === "approved" || record.status === "handedOver" ? (
        <WebsiteHandover
          agents={agents}
          downloadAdapter={downloadAdapter}
          onViewRevision={setInspection}
          record={record}
        />
      ) : null}
      <WebsiteQaPanel
        agents={agents}
        artifactLoader={artifactLoader}
        reportState={reportState}
        revision={revision}
        view={qaView}
      />
      <WebsiteVersionHistory
        agents={agents}
        onSelectRevision={setInspection}
        record={record}
        selectedRevision={selected}
      />
      <WebsiteDecisionPanel
        actor={currentPubkey ?? ""}
        onDecision={currentPubkey ? onDecision : undefined}
        record={record}
        selectedRevision={selected}
      />
    </section>
  );
}

/**
 * One small insertion point for the message row and thread panel. It renders
 * nothing unless this exact event id maps to a verified head on the surface it
 * belongs to.
 */
export function WebsiteMessageAttachment({
  channelId,
  currentPubkey,
  layoutVariant = "default",
  message,
  profiles,
}: {
  channelId?: string | null;
  currentPubkey?: string;
  layoutVariant?: "default" | "thread-reply";
  message: TimelineMessage;
  profiles?: UserProfileLookup;
}) {
  const { communityId, head, surface } = useWebsiteAttachmentContext({
    channelId: channelId ?? null,
    layoutVariant,
    message,
  });
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
  return (
    <WebsiteThreadAttachment
      communityId={communityId}
      currentPubkey={currentPubkey}
      head={head}
      message={message}
      profiles={profiles}
    />
  );
}
